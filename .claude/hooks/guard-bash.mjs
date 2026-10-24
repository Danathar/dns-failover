#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool (wired up in .claude/settings.json).
//
// Threat model: this hook prevents an agent that is following instructions
// from carelessly or accidentally (a) writing to the wrong GitHub repository,
// (b) running destructive git commands, or (c) touching the live DNS host:
// running an installer, configure.py, monitor.py (even `--dry-run`, which
// calls the live Tailscale API with real credentials), dns-upstream-check.py
// against real paths, `sudo`, systemctl/service on dnsmasq/stubby/the units,
// the dnsmasq/stubby daemons, or any Tailscale API call. It is NOT a sandbox
// against deliberate obfuscation (eval of built strings, shell variables,
// scripts written to disk and executed, aliases, ...). The real boundaries are
// token scope / the Hive GitHub App's repository access, the files'
// permissions on the host, and review of the changes (docs/risk-tiers.md);
// findings that need deliberate obfuscation are out of scope here.
//
// Why: this repository is the source of an existing DNS server's failover
// setup. The installers rewrite /etc/dnsmasq.conf and enable timers as root;
// monitor.py talks to the real Tailscale API and can switch the whole
// tailnet's DNS off; dns-upstream-check.py rewrites /run/dns-upstream and
// SIGHUPs the real dnsmasq. Running any of them "to see what happens" changes
// production. Code is exercised only through the unit tests (fakes, temp
// dirs) and the e2e test inside a throwaway container. And a bare `gh` write
// in a clone resolves its target from git remotes or gh's default, which is
// how an agent files issues or PRs on the wrong repository.
//
// Protocol (https://docs.anthropic.com/en/docs/claude-code/hooks): the hook
// receives JSON on stdin ({ tool_name, tool_input: { command } }). Exit 0 lets
// the call proceed; exit 2 blocks it and feeds stderr back to the model.
//
// What is blocked (fail closed when unsure):
//   GitHub / git
//   - gh pr|issue|discussion|release|workflow|run|label|repo|secret|variable|
//     ruleset|cache subcommands that are not read-only and do not target
//     Danathar/dns-failover via --repo/-R or a GH_REPO= prefix; a
//     write whose arguments name a github.com URL of another repository.
//   - gh api with a mutating method (or -f/-F/--input body) against anything
//     outside repos/Danathar/dns-failover; GraphQL mutations.
//   - git push with force, --mirror, a remote other than `origin`, a URL
//     remote, or no explicit remote.
//   - git config / git remote changes that re-point `origin` or push URLs.
//   - git options that write a file, read outside the repository or run a
//     program on the pre-approved read commands: --output[=FILE], --no-index,
//     --ext-diff, git grep -O/--open-files-in-pager, --exec-path=DIR, and
//     `-c` keys such as diff.external, core.pager, alias.*, protocol.*
//     (protocol.ext.allow=always); --upload-pack (and its abbreviations such
//     as --upl), --exec and clone/ls-remote -u on git
//     fetch|pull|clone|ls-remote|archive, which run the named program;
//     GIT_* / PAGER / EDITOR variables (inline or exported) other than
//     identity and no-op pagers (GIT_EXTERNAL_DIFF=, GIT_TRACE=FILE, GIT_DIR=, ...).
//   - git, node, python/pytest, curl/wget, systemctl/service/tailscale or a
//     shell run through xargs: xargs appends words read at run time
//     (`printf '%s\n' --output=FILE | xargs git log`), so none of the
//     argument checks here could see them.
//   - `bash -n` (pre-approved syntax check) with a word beginning with +
//     (`+n`, `+o noexec` turn -n off and run the script) or one bash could
//     expand into such a word ({, }, *, ?, [, $, backtick).
//   node
//   - `node --test` with any option outside the test-runner allowlist
//     (--import, --require/-r, --loader, module reporters,
//     --test-reporter-destination=FILE, ...), and node with NODE_OPTIONS or
//     another NODE_* variable set inline or exported; node -e/-p code that
//     names api.tailscale.com.
//   python
//   - `python3 -m pytest` / `pytest` / `python3 -m coverage` (pre-approved in
//     .claude/settings.json) with any option outside an allowlist of
//     reporting/selection options: -p, --pyargs, -c/--config-file, --rootdir,
//     -o/--override-ini, --confcutdir, --basetemp, --junitxml, -W, ... all load
//     code, read another config or write files. Test operands must be paths
//     inside the project. PYTEST_*, COVERAGE_* and PYTHON* variables (inline
//     or exported) other than a short no-op list are refused: PYTEST_ADDOPTS /
//     PYTEST_PLUGINS inject `-p`, PYTHONPATH / PYTHONSTARTUP load code.
//   - python (any version) with a protected script as an operand, or with
//     `-c` code that names one (see below) or api.tailscale.com.
//   Host-modifying commands
//   - Executing install-dns-failover.sh, tailscale-dns-failover/install.sh,
//     tests/e2e/in-container.sh (it runs the installers), configure.py or
//     monitor.py (any arguments, including --dry-run): directly, via
//     bash/sh/zsh/dash/ksh/fish/..., source, `.`, python,
//     env/timeout/xargs/flock/watch/other wrappers, `find -exec`,
//     systemd-run, or via `distrobox enter` / `toolbox run`. The
//     only exemption is the e2e harness: `podman run ...` / `docker run ...`
//     with a `tests/e2e` path (the scripts then run inside a throwaway
//     container).
//   - dns-upstream-check.py unless EVERY one of these holds: `--no-reload`
//     is present, `--directory` and `--pid-file` are given, and both resolve
//     (symlinks followed, checked on disk) to a path strictly inside the OS
//     temp dir, /tmp, /var/tmp or a `tests/` directory of this project; the
//     directory exists, and the pid file's parent exists. Only the listed
//     options are accepted, spelled in full: argparse would otherwise accept
//     abbreviations (`--dir`, `--no-rel`) this hook cannot match. Relative or
//     expanding paths ($, `, ~, .., globs) never qualify.
//   - sudo / doas / pkexec / run0 / su / runuser in any position of a wrapper
//     chain, including behind systemd-run, flatpak-spawn and `find -exec`.
//   - systemctl subcommands that change state (start, stop, restart, reload,
//     enable, disable, mask, kill, daemon-reload, edit, link, ...) unless the
//     call is plainly `--user` and names none of dnsmasq, stubby or this
//     project's units; `service NAME ACTION` other than `status`;
//     pkill/killall naming dnsmasq or stubby.
//   - the dnsmasq and stubby daemons (also as /usr/sbin/dnsmasq, via
//     /etc/init.d/): only the validate-and-exit forms `dnsmasq --test`
//     (with --conf-file) and `stubby -i`, plus --version/--help, are fine.
//     `tailscaled` is never fine. Behind a program this hook does not list
//     (`setarch x86_64 tailscaled`) a daemon's name counts as that daemon,
//     unless the program is a look-up tool (pgrep, pidof, journalctl, ps,
//     man, dpkg, ls, ...; see DAEMON_LOOKUP_PROGRAMS).
//   - `tailscale` CLI subcommands other than status/version/ip/ping/netcheck/
//     whois/help: `tailscale set --accept-dns` is the change monitor.py makes.
//   - curl/wget/http/https/xh naming tailscale.com (the API lives at
//     api.tailscale.com), or reading URLs from a config/input file (-K,
//     --config, -i, --input-file) where this hook cannot see them.
//   - distrobox/toolbox enter and podman/docker exec/attach: they reach the
//     developer's real long-lived container (distrobox containers are
//     podman containers), bypassing every rule above.
//
// Parsing notes: redirections (`>log`, `2>&1`, `&>f`, `<file`) end the word
// and are not arguments, so `./monitor.py>log` is still the script. A shell
// or python with no script operand that reads a protected script on stdin
// (`cat install-dns-failover.sh | sh`, `bash -s < install.sh`,
// `bash -c "$(cat install.sh)"`) counts as running it. Quoted heredoc bodies
// are data. Wrappers (env, timeout, xargs, time, flock, watch, taskset, chrt,
// unshare, nsenter, setpriv, chroot, busybox, exec -a, ...) are looked through
// to the command they run, not to a later argument; so are
// `find -exec|-execdir|-ok|-okdir CMD ... ;`, the body after `function NAME`
// and the command after `coproc`. The wrapper list is closed: a wrapper
// outside it hides its command. Wrapper options are read as getopt reads
// them, so a packed (`env -iu X`) or abbreviated (`env --uns X`) option's
// value is not taken for the command. A word is read as the shell reads it:
// `$'...'` escapes (`\xHH`, `\NNN`, `\uHHHH`) and `$"..."` are decoded, and
// a command name that braces (`{git,}`) or a wildcard in a path
// (`/usr/bin/g?t`) can build into a checked one counts as that command. A
// `$'...'` string holding `\'`, or `\c` before a quote or backslash, is
// refused (see MISREAD_ANSI_C). A plain `cd DIR` inside the project is followed; any other directory change
// (`eval cd DIR`, `{cd,} DIR`, `$X DIR`, popd, a cd out of the project) leaves
// the working directory unknown for the rest of the command line, so the
// checks that need it (pytest operands, relative container mounts) refuse.
// Deliberate obfuscation (variables, built strings, scripts written then run)
// stays out of scope.
//
// The reading itself (words, quotes, `$'...'`, substitutions, heredocs, brace
// and wildcard names, wrappers, command strings, the git option and
// environment rules, the time budget) is the shared shell-reader.mjs, the same
// file in every repository that carries this guard; this file holds this
// repository's policy.
//
// Read-only gh commands (view, list, status, diff, checks, api GET, ...) are
// always allowed. The command is split into segments on && || ; | & newlines,
// subshells and command substitutions; shell -c, eval, watch and
// `flock FILE -c` strings are analysed recursively. Quoted text is data, so a quoted "sudo" or script name inside
// an `echo` or a read-only command is fine.

import { basename, dirname, join, isAbsolute, resolve } from 'node:path';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// Reading the command line as the shell would is shared with the other
// repositories that carry this guard; see shell-reader.mjs. That file is the
// same in all of them (tests/shell-reader.test.mjs next to this file pins its
// sha256), so a reading fix lands in its canonical copy in Danathar/akmods
// first and is copied here byte for byte. What is refused, and why, stays here.
import {
    ARGUMENT_ONLY_PROGRAMS, braceForms, BUDGET_MS, changesDirectory, CHDIR, COMMAND_STRING_SEPARATORS,
    commandNameReader, commandStrings, EXEC_GIT_CONFIG, expandWrapperOptions, extractSubstitutions, FIND_EXEC, firstWord,
    fishScripts, GIT_EXEC_OPTION, GIT_SHORT_UPLOAD_PACK, GIT_UPLOAD_PACK_OPTION, GIT_UPLOAD_PACK_SUBCOMMANDS, isAssignment,
    KEYWORDS, MAX_UNLISTED_INNER, OverBudget, REFUSED_GIT_OPTION, RISKY_GIT_CONFIG, riskyEnv, SAFE_ENV, SHELLS, spend,
    startBudget, tokenize, unquoted, WATCHED_ENV, WRAPPERS, wrapperTarget,
} from './shell-reader.mjs';

// Re-exported for the tests and tools that import them from the guard.
export { BUDGET_MS, extractSubstitutions, tokenize } from './shell-reader.mjs';

export const REPO = 'danathar/dns-failover';

const GUIDANCE =
    'Hard rules for this repository: never run an installer, configure.py, monitor.py (not even --dry-run: it calls the live ' +
    'Tailscale API), dns-upstream-check.py against real paths, sudo, systemctl/service on dnsmasq/stubby/the units, or any ' +
    'Tailscale API call on the host; exercise code only through python3 -m pytest and the tests/e2e container harness. ' +
    'GitHub writes go to Danathar/dns-failover (add `--repo Danathar/dns-failover`), ' +
    'and git pushes only to `origin`.';

// gh command groups whose non-read actions mutate a repository.
// Value = actions that are read-only (or purely local) and need no --repo.
const GH_GROUPS = {
    pr: ['view', 'list', 'status', 'diff', 'checks', 'checkout'],
    issue: ['view', 'list', 'status'],
    release: ['view', 'list', 'download', 'verify', 'verify-asset'],
    workflow: ['view', 'list'],
    run: ['view', 'list', 'watch', 'download'],
    label: ['list'],
    repo: ['view', 'list', 'clone', 'gitignore', 'license'],
    secret: ['list'],
    variable: ['list', 'get'],
    ruleset: ['list', 'view', 'check'],
    cache: ['list'],
    discussion: ['view', 'list'],
    codespace: ['list', 'view', 'logs', 'ports'],
};

// gh groups outside GH_GROUPS that may run without a repo target.
// true = every action is read-only or local; array = only those actions.
const GH_OTHER_READONLY = {
    auth: ['status'],
    browse: true,
    search: true,
    status: true,
    config: ['get', 'list'],
    alias: ['list'],
    extension: ['list', 'search', 'browse'],
    'ssh-key': ['list'],
    'gpg-key': ['list'],
    org: ['list'],
    project: ['list', 'view', 'field-list', 'item-list'],
    attestation: ['verify', 'inspect', 'trusted-root'],
    completion: true,
    help: true,
    version: true,
};

// These look a program up by its name or path and never run it, so behind them
// a DNS or Tailscale daemon's name is not read as a command (`pgrep -a
// dnsmasq`, `journalctl -u stubby`, `ls -l /usr/sbin/tailscaled`). Behind any
// other program it is: `setarch x86_64 tailscaled` starts the daemon. As with
// ARGUMENT_ONLY_PROGRAMS only the bare spelling counts, and leaving a look-up
// tool out can only over-refuse.
const DAEMON_LOOKUP_PROGRAMS = new Set([
    'pgrep', 'pidof', 'ps', 'pstree', 'lsof', 'journalctl', 'man', 'whatis', 'apropos', 'apt', 'apt-cache', 'dpkg',
    'dpkg-query', 'rpm', 'ls', 'stat', 'file', 'readlink', 'realpath', 'type',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise OWNER/REPO, HOST/OWNER/REPO, or a github URL to "owner/repo". */
export function normalizeRepo(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/^(?:https?:\/\/|git@|ssh:\/\/git@)?github\.com[/:]/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
}

/** True if a word is a github.com URL (or git@/ssh form) for a repository other than REPO. */
export function namesOtherRepo(word) {
    const m = /^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(
        String(word)
    );
    return m !== null && m[1].toLowerCase() !== REPO;
}

function isTarget(value) {
    return normalizeRepo(value) === REPO;
}

/**
 * Extract the effective --repo/-R value from gh args, or null. gh honours the
 * LAST repeated flag, so a fork flag followed by another repo must not pass:
 * if any value is not the fork, that one is returned; otherwise the last.
 */
function repoFlag(args) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--repo' || a === '-R') values.push(args[++i] ?? '');
        else if (a.startsWith('--repo=')) values.push(a.slice(7));
        else if (a.startsWith('-R') && a.length > 2 && !a.startsWith('--')) values.push(a.slice(2));
    }
    if (!values.length) return null;
    return values.find((v) => !isTarget(v)) ?? values[values.length - 1];
}

const block = (reason) => ({ blocked: true, reason: `${reason}\n${GUIDANCE}` });

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

function checkGhApi(args) {
    let method = null;
    let hasBody = false;
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase();
        else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
        else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
        else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
            hasBody = true;
            i++;
        } else if (/^--(field|raw-field|input)=/.test(a) || /^-[fF]./.test(a)) hasBody = true;
        else if (['-H', '--header', '--hostname', '-q', '--jq', '-t', '--template', '--cache'].includes(a)) i++;
        else if (!a.startsWith('-')) positionals.push(a);
    }
    const endpoint = (positionals[0] ?? '').replace(/^\/+/, '');
    const mutating = method ? !['GET', 'HEAD'].includes(method) : hasBody;
    const isGraphql = endpoint.toLowerCase() === 'graphql';

    if (isGraphql) {
        // GraphQL is always POST; allow queries, refuse mutations (target unknowable).
        if (args.some((a) => /\bmutation\b/i.test(a))) {
            return block('Blocked: `gh api graphql` mutation. The target repository cannot be verified.');
        }
        // The query must be a visible literal: a body from a file/stdin (--input,
        // query=@file) or a shell variable could hide a mutation.
        const query = args.map((a) => /^query=([\s\S]*)$/.exec(a)).find(Boolean);
        const opaque =
            args.some((a) => a === '--input' || a.startsWith('--input=')) ||
            !query ||
            /^[@$]/.test(query[1]);
        if (opaque) {
            return block('Blocked: `gh api graphql` without an inline literal `-f query=...`; the request cannot be inspected for mutations.');
        }
        return null;
    }
    if (!mutating) return null;

    // `{owner}/{repo}` placeholders resolve to gh's default repo, which may be a different repository.
    const m = /^repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/i.exec(endpoint);
    if (m && m[1].toLowerCase() === REPO) return null;

    return block(
        `Blocked: mutating \`gh api\` call (${method ?? 'implicit POST'}) to "${endpoint || '?'}"; ` +
            'only paths under repos/Danathar/dns-failover are allowed.'
    );
}

function checkGh(args, envRepo) {
    // Locate group and action (first two non-flag words).
    // The value of --repo/-R is not a command word, wherever the flag sits
    // (`gh -R chrisvel/tududi pr create` must still resolve to group "pr").
    const plain = args.filter((a, n) => !a.startsWith('-') && !['--repo', '-R'].includes(args[n - 1]));
    const group = plain[0];
    if (!group) return null;

    if (group === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
    if (!Object.hasOwn(GH_GROUPS, group)) {
        // Fail closed: groups outside GH_GROUPS pass only via the explicit
        // read-only allowlist (GH_OTHER_READONLY). This also covers `gh alias set`,
        // which could define an alias that hides a write.
        const allowed = GH_OTHER_READONLY[group];
        if (allowed === true || (Array.isArray(allowed) && allowed.includes(plain[1] ?? ''))) return null;
        return block(
            `Blocked: \`gh ${group} ${plain[1] ?? ''}\` is not on the read-only allowlist ` +
                '(unknown or mutating gh command; the target repository cannot be verified).'
        );
    }

    const action = plain[1] ?? '';
    const flagRepo = repoFlag(args);
    const target = flagRepo ?? envRepo;

    if (group === 'repo' && action === 'set-default') {
        const rest = plain.slice(2);
        if (args.includes('--view') || args.includes('-v')) return null;
        if (rest.length === 1 && isTarget(rest[0])) return null;
        return block('Blocked: `gh repo set-default` must be `gh repo set-default Danathar/dns-failover` (or --view).');
    }

    if (GH_GROUPS[group].includes(action)) return null; // read-only

    // A write whose arguments name another repository's github.com URL
    // (`gh pr merge https://github.com/other/x/pull/1`): gh uses the URL, not
    // --repo, so it is refused even when --repo points at this repository.
    const other = args.find(namesOtherRepo);
    if (other !== undefined) {
        return block(`Blocked: \`gh ${group} ${action}\` names another repository ("${other}").`);
    }

    if (group === 'repo') {
        // Repo-scoped writes take the repo as a positional argument.
        const positional = plain.slice(2);
        if (isTarget(flagRepo ?? '') || (positional.length && isTarget(positional[0])) || isTarget(envRepo ?? '')) return null;
        return block(`Blocked: \`gh repo ${action}\` without an explicit Danathar/dns-failover target.`);
    }

    if (target === null) {
        return block(`Blocked: \`gh ${group} ${action}\` has no --repo/-R/GH_REPO; gh would resolve the repository from git remotes or its default.`);
    }
    if (!isTarget(target)) {
        return block(`Blocked: \`gh ${group} ${action}\` targets "${target}", not Danathar/dns-failover.`);
    }
    if (group === 'pr' && action === 'create') return checkPrCreate(args);
    return null;
}

/** Convention: PRs are created with an explicit `--base main` and `--head <branch>`. */
function checkPrCreate(args) {
    // Flags whose value must be skipped so e.g. `--body "-Bump deps"` is not read as `-B`.
    const takesValue = new Set([
        '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--assignee', '-a',
        '--reviewer', '-r', '--milestone', '-m', '--project', '-p', '--template', '-T',
    ]);
    const flagValue = (long, short) => {
        let found = null;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === long || a === short) found = args[i + 1] ?? '';
            else if (a.startsWith(`${long}=`)) found = a.slice(long.length + 1);
            else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found = a.slice(2); // -Bdevelop
            if (a === long || a === short || takesValue.has(a)) i++; // skip this flag's value
        }
        return found; // gh honours the last occurrence of a repeated flag
    };
    const base = flagValue('--base', '-B');
    const head = flagValue('--head', '-H');
    if (base !== 'main') {
        return block('Blocked: `gh pr create` needs an explicit `--base main`.');
    }
    if (!head) {
        return block('Blocked: `gh pr create` needs an explicit `--head <branch>`.');
    }
    return null;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// The git option, `-c` key and environment rules are in shell-reader.mjs
// (RISKY_GIT_CONFIG, EXEC_GIT_CONFIG, REFUSED_GIT_OPTION, the upload-pack and
// exec options, WATCHED_ENV / SAFE_ENV and riskyEnv()).

// This repository also watches the variables python, pytest and coverage read
// to load code, inject options or write files (PYTHONPATH, PYTHONSTARTUP,
// PYTEST_ADDOPTS, PYTEST_PLUGINS, COVERAGE_PROCESS_START, ...), wherever the
// shared riskyEnv() is asked: every PYTHON* / PYTEST_* / COVERAGE_* name is
// refused unless PYTHON_SAFE_ENV lists it.
const PYTHON_ENV = /^(PYTHON|PYTEST_|COVERAGE_)/;
const PYTHON_SAFE_ENV = new Set([
    'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'PYTHONHASHSEED', 'PYTHONUTF8', 'PYTHONIOENCODING',
    'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
]);

/** Name of the first risky variable in an env map ({ NAME: value | null }): riskyEnv() plus the python variables above. */
function riskyVariable(env) {
    return Object.keys(env).find(
        (k) => riskyEnv({ [k]: env[k] }) !== undefined || (PYTHON_ENV.test(k) && !PYTHON_SAFE_ENV.has(k))
    );
}

function checkGit(args, inlineEnv = {}, exported = {}) {
    // Walk global options to find the subcommand, vetting `-c key=value`.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        const a = args[i];
        let configKey = null;
        if (a === '-c' || a === '--config-env') configKey = (args[i + 1] ?? '').split('=')[0];
        else if (a.startsWith('--config-env=')) configKey = a.slice(13).split('=')[0];
        if (configKey !== null && RISKY_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` could redirect pushes or credentials.`);
        }
        if (configKey !== null && EXEC_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` makes git run a program or read other config.`);
        }
        if (a.startsWith('--exec-path=')) {
            return block('Blocked: `git --exec-path=DIR` runs git commands from another directory.');
        }
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);

    const env = { ...exported, ...inlineEnv };
    if (sub === 'push') {
        const pushKey = Object.keys(env).find((k) => /^(GIT_CONFIG_|GIT_SSH)/i.test(k));
        if (pushKey) return block(`Blocked: \`git push\` with ${pushKey}= could redirect the push.`);
    }
    const envKey = riskyVariable(env);
    if (envKey) {
        return block(
            `Blocked: \`git\` with ${envKey} set; it can make git run a program, write a file or read another repository/config. ` +
                'Only GIT_AUTHOR_*/GIT_COMMITTER_* identity and PAGER/GIT_PAGER/GIT_EDITOR=cat|true are allowed.'
        );
    }
    const refused = args.find((a) => REFUSED_GIT_OPTION.test(a)) ?? (sub === 'grep' ? rest.find((a) => /^-[a-zA-Z]*O/.test(a)) : undefined);
    if (refused !== undefined) {
        return block(
            `Blocked: \`git ${sub ?? ''} ${refused}\` writes a file, reads outside the repository or runs a program. ` +
                'Read the output on stdout instead (pipe it, or use the Write tool to save it).'
        );
    }
    if (GIT_UPLOAD_PACK_SUBCOMMANDS.has(sub)) {
        const program = rest.find(
            (a) =>
                GIT_UPLOAD_PACK_OPTION.test(a) ||
                ((sub === 'ls-remote' || sub === 'archive') && GIT_EXEC_OPTION.test(a)) ||
                ((sub === 'clone' || sub === 'ls-remote') && GIT_SHORT_UPLOAD_PACK.test(a))
        );
        if (program !== undefined) {
            return block(
                `Blocked: \`git ${sub} ${program}\` runs the program it names (--upload-pack, --exec, clone/ls-remote -u). ` +
                    'Use plain `git fetch [remote]`.'
            );
        }
    }
    if (sub === 'push') return checkGitPush(rest);
    if (sub === 'remote') return checkGitRemote(rest);
    if (sub === 'config') return checkGitConfig(rest);
    return null;
}

/** Writes to push-redirecting config keys (`git config remote.origin.url ...`). */
function checkGitConfig(rest) {
    // Only flags that pick a read mode. --show-origin/--show-scope are display
    // modifiers: `git config --show-scope remote.origin.url URL` still writes.
    const readOnly = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
    if (rest.some((a) => readOnly.includes(a))) return null;

    // Collect positionals, skipping the values of options that take one
    // (`git config -f .git/config remote.origin.url <url>`).
    const valueFlags = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];
    const positionals = [];
    for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (valueFlags.includes(a)) k++;
        else if (!a.startsWith('-')) positionals.push(a);
    }

    // Modern syntax: `git config set|unset|replace-all|... <key> [value]`.
    const verbs = ['set', 'unset', 'replace-all', 'add', 'rename-section', 'remove-section', 'edit'];
    const readVerbs = ['get', 'list'];
    let modifies = false;
    const verbRenames = positionals[0] === 'rename-section';
    if (positionals.length && readVerbs.includes(positionals[0])) return null;
    if (positionals.length && verbs.includes(positionals[0])) {
        if (positionals[0] === 'edit') {
            return block('Blocked: `git config edit` could redirect pushes or credentials.');
        }
        positionals.shift();
        modifies = true;
    }
    const key = positionals[0];
    // Legacy syntax: a write is `key value`, or --unset/--add/--replace-all/section edits.
    modifies =
        modifies ||
        positionals.length > 1 ||
        rest.some((a) => /^--(unset|unset-all|add|replace-all|remove-section|rename-section)$/.test(a));
    if (key !== undefined && RISKY_GIT_CONFIG.test(key) && modifies) {
        return block(`Blocked: \`git config ${key}\` write could redirect pushes or credentials.`);
    }
    // Section renames move settings between names: check both the old and the new
    // section (`git config rename-section foo remote.origin` adopts foo.pushurl).
    const renames = verbRenames || rest.includes('--rename-section');
    if (renames && positionals.some((p) => RISKY_GIT_CONFIG.test(`${p}.x`))) {
        return block('Blocked: `git config rename-section` involving a remote/url/credential section could redirect pushes.');
    }
    if (rest.includes('--edit') || rest.includes('-e')) {
        return block('Blocked: `git config --edit` could redirect pushes or credentials.');
    }
    return null;
}

// Long `git push` options that force, mirror, delete or redirect. git accepts any
// unambiguous abbreviation of a long option (`--force-w`, `--del`, `--mirr`), so a
// word that is a prefix of one of these is refused, not just the full spelling.
const PUSH_DANGER = [
    ['--force', 'force push'], ['--force-with-lease', 'force push'], ['--force-if-includes', 'force push'],
    ['--mirror', '`git push --mirror` overwrites the remote'], ['--delete', 'deleting remote refs'],
    ['--prune', 'deleting remote refs (--prune)'], ['--repo', '`git push --repo` redirects the push; name the remote `origin` instead'],
];

function checkGitPush(rest) {
    const positionals = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) {
            i++;
            continue;
        }
        if (a.startsWith('--') && a.length > 2) {
            const name = a.split('=')[0];
            const hit = name.length >= 3 ? PUSH_DANGER.find(([full]) => full.startsWith(name)) : undefined;
            if (hit) return block(`Blocked: \`git push ${a}\`: ${hit[1]}.`);
        } else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) {
            return block('Blocked: force push (-f).');
        } else if (/^-[a-zA-Z]*d[a-zA-Z]*$/.test(a)) {
            return block('Blocked: `git push -d` deletes remote refs.');
        } else if (!a.startsWith('-')) positionals.push(a);
    }
    const [remote, ...refspecs] = positionals;
    if (remote === undefined) {
        return block('Blocked: `git push` without an explicit remote; use `git push origin <branch>`.');
    }
    if (remote !== 'origin') {
        return block(`Blocked: \`git push ${remote}\`; only the \`origin\` remote may be pushed to.`);
    }
    if (refspecs.some((r) => r.startsWith('+'))) {
        return block('Blocked: force push via "+" refspec.');
    }
    if (refspecs.some((r) => r.startsWith(':'))) {
        return block('Blocked: `git push origin :ref` deletes a remote ref.');
    }
    return null;
}

function checkGitRemote(rest) {
    const sub = rest[0];
    const flags = [];
    const plain = [];
    for (let k = 1; k < rest.length; k++) {
        const a = rest[k];
        if (a.startsWith('-')) {
            flags.push(a);
            if (['-t', '-m', '--track', '--master'].includes(a)) k++; // option takes a value
        } else plain.push(a);
    }
    const [name, url] = plain;
    const originHint =
        '`origin` is https://github.com/Danathar/dns-failover; it must not be removed, renamed or re-pointed.';

    // Anything that could remove, replace or re-point `origin` would defeat the
    // "push only to origin" rule (`git push origin` would then reach another repo).
    if (['remove', 'rm', 'rename'].includes(sub) && plain.includes('origin')) {
        return block(`Blocked: \`git remote ${sub}\` involving origin. ${originHint}`);
    }
    if (sub === 'add' && name === 'origin' && !isTarget(url ?? '')) {
        return block(`Blocked: \`git remote add origin\` with a URL that is not this repository. ${originHint}`);
    }
    if (sub !== 'set-url') return null;
    if (url === undefined) return null;
    const push = flags.includes('--push');
    if (push && url !== 'DISABLE' && !(name === 'origin' && isTarget(url))) {
        return block(
            `Blocked: \`git remote set-url --push ${name}\` to a real URL. ` +
                'Use `DISABLE`, or the Danathar/dns-failover URL for origin.'
        );
    }
    if (name === 'origin' && !isTarget(url)) {
        return block(`Blocked: \`origin\` may only point at https://github.com/Danathar/dns-failover.`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// node --test
// ---------------------------------------------------------------------------

// `node --test` is pre-approved in .claude/settings.json, but node options load
// and run any code (`--import`, `--require`/`-r`, `--loader`, a module
// `--test-reporter`, `--test-global-setup`, `--experimental-config-file`) or
// write files (`--test-reporter-destination=FILE`, `--cpu-prof-dir`,
// `--redirect-warnings`). In test mode only the test-runner options below are
// allowed; everything else, and any NODE_* variable such as NODE_OPTIONS, is
// refused. Value: null = any value, RegExp = the value must match.
const NODE_TEST_OPTIONS = {
    '--test': false,
    '--test-only': false,
    '--watch': false,
    '--test-force-exit': false,
    '--experimental-test-coverage': false,
    '--no-warnings': false,
    '--enable-source-maps': false,
    '--test-name-pattern': null,
    '--test-skip-pattern': null,
    '--test-coverage-include': null,
    '--test-coverage-exclude': null,
    '--test-concurrency': /^\d+$/,
    '--test-timeout': /^\d+$/,
    '--test-shard': /^\d+\/\d+$/,
    '--test-isolation': /^(process|none)$/,
    '--experimental-test-isolation': /^(process|none)$/,
    '--test-coverage-lines': /^\d+(\.\d+)?$/,
    '--test-coverage-branches': /^\d+(\.\d+)?$/,
    '--test-coverage-functions': /^\d+(\.\d+)?$/,
    '--test-reporter': /^(spec|tap|dot|junit|lcov)$/,
    '--test-reporter-destination': /^(stdout|stderr)$/,
};

function checkNode(cmd, args, env) {
    const envKey = Object.keys(env).find((k) => /^NODE_/.test(k) && !SAFE_ENV.has(k));
    if (envKey) {
        return block(`Blocked: \`${cmd}\` with ${envKey} set; NODE_OPTIONS and other NODE_* variables can load code or write files.`);
    }
    // `node -e 'fetch("https://api.tailscale.com/...")'`: inline code that calls the Tailscale API.
    const evalAt = args.findIndex((a) => /^(-e|-p|-pe|--eval|--print)(=|$)/.test(a));
    if (evalAt !== -1) {
        const code = args[evalAt].includes('=') ? args[evalAt].slice(args[evalAt].indexOf('=') + 1) : (args[evalAt + 1] ?? '');
        if (TAILSCALE_API.test(code)) return block(`Blocked: \`${cmd} ${args[evalAt]}\` code names the Tailscale API; agents never call it.`);
    }
    if (!args.includes('--test')) return null; // not the pre-approved test runner; Claude Code asks
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-') || a === '-' || a === '--') continue; // test files / patterns
        const eq = a.indexOf('=');
        const name = eq === -1 ? a : a.slice(0, eq);
        const rule = Object.hasOwn(NODE_TEST_OPTIONS, name) ? NODE_TEST_OPTIONS[name] : undefined;
        let ok = rule !== undefined;
        if (ok && rule === false) ok = eq === -1;
        else if (ok) {
            const value = eq === -1 ? args[++i] : a.slice(eq + 1);
            ok = value !== undefined && (rule === null || rule.test(value));
        }
        if (!ok) {
            return block(
                `Blocked: \`${cmd} --test ... ${a}\`; only test-runner options (name/skip pattern, concurrency, timeout, shard, ` +
                    'isolation, coverage, --watch, --test-only, reporters spec|tap|dot|junit|lcov to stdout|stderr) are allowed. ' +
                    'Other node options can run code (--import, --require, --loader, module reporters) or write files.'
            );
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// python / pytest / coverage
// ---------------------------------------------------------------------------

const PYTHON_NAME = /^(?:python|pypy)[0-9.]*$/;
const isPython = (cmd) => PYTHON_NAME.test(cmd);
const isPytest = (cmd) => cmd === 'pytest' || cmd === 'py.test';

/** Project root (real path); relative operands and `tests/` temp dirs are judged against it. */
function projectRoot() {
    const root = (process.env.CLAUDE_PROJECT_DIR || process.cwd()).replace(/\/+$/, '');
    try {
        return realpathSync(root);
    } catch {
        return root;
    }
}

const strictlyInside = (path, root) => path.startsWith(`${root}/`);
const insideOrEqual = (path, root) => path === root || strictlyInside(path, root);

/** The shell's working directory for a segment: undefined = the hook's own, null = unknown or outside the project. */
const cwdOf = (state) => (state.cwd === undefined ? process.cwd() : state.cwd);

/** True if the working directory is known and inside the project. */
function cwdInProject(state) {
    const cwd = cwdOf(state);
    if (cwd === null) return false;
    let real = cwd;
    try {
        real = realpathSync(cwd);
    } catch {
        // a directory that does not exist yet is judged by its text
    }
    return insideOrEqual(real, projectRoot());
}

/**
 * Parse an option list against a table ({ name: false | null | RegExp }, as
 * NODE_TEST_OPTIONS: false = flag, null = any value, RegExp = value must
 * match). `names` may also be matched by `extra(arg)` (clusters and attached
 * values). Returns the first refused option and the operands. Options not in
 * the table are refused, so argparse abbreviations (`--pyarg`) never match.
 */
function parseOptions(args, table, extra) {
    const operands = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') {
            operands.push(...args.slice(i + 1));
            break;
        }
        if (!a.startsWith('-') || a === '-') {
            operands.push(a);
            continue;
        }
        if (extra?.(a)) continue;
        const eq = a.indexOf('=');
        const name = eq === -1 ? a : a.slice(0, eq);
        const rule = Object.hasOwn(table, name) ? table[name] : undefined;
        let ok = rule !== undefined;
        if (ok && rule === false) ok = eq === -1;
        else if (ok) {
            const value = eq === -1 ? args[++i] : a.slice(eq + 1);
            ok = value !== undefined && (rule === null || rule.test(value));
        }
        if (!ok) return { bad: a, operands };
    }
    return { bad: undefined, operands };
}

// `python3 -m pytest` / `pytest` is pre-approved in .claude/settings.json, but
// pytest options load code (`-p`, `--pyargs`, `--doctest-modules`, a conftest
// or plugin named by `--rootdir`/`-c`/`-o`/`--confcutdir`), apply other config,
// or write and delete files (`--junitxml`, `--basetemp`, `--result-log`).
// Only the reporting and selection options below are accepted. Value: false =
// flag, null = any value, RegExp = the value must match.
const PYTEST_OPTIONS = {
    '--verbose': false,
    '--quiet': false,
    '--exitfirst': false,
    '--showlocals': false,
    '--lf': false,
    '--last-failed': false,
    '--ff': false,
    '--failed-first': false,
    '--nf': false,
    '--new-first': false,
    '--sw': false,
    '--stepwise': false,
    '--co': false,
    '--collect-only': false,
    '--no-header': false,
    '--no-summary': false,
    '--disable-warnings': false,
    '--strict-markers': false,
    '--cache-clear': false,
    '--full-trace': false,
    '--runxfail': false,
    '--setup-show': false,
    '--fixtures': false,
    '--version': false,
    '--help': false,
    '-h': false,
    '-k': null,
    '-m': null,
    '-r': /^[a-zA-Z]+$/,
    '--deselect': null,
    '--ignore': null,
    '--ignore-glob': null,
    '--maxfail': /^\d+$/,
    '--durations': /^\d+$/,
    '--durations-min': /^\d+(\.\d+)?$/,
    '--tb': /^(auto|long|short|line|native|no)$/,
    '--color': /^(yes|no|auto)$/,
    '--capture': /^(fd|sys|no|tee-sys)$/,
    '--show-capture': /^(no|stdout|stderr|log|all)$/,
};
// `-vv`, `-xvs`: clusters of flag letters only (`-vp name` would hide `-p`); `-kEXPR`, `-mEXPR`, `-rA`.
const pytestExtra = (a) =>
    /^-[vqxsl]+$/.test(a) || /^-[km]./.test(a) || /^-r[a-zA-Z]+$/.test(a);

/** A pytest test operand (`path`, `path::test`) must lie inside the project, so no foreign conftest or test file is loaded. */
function operandInProject(operand, state) {
    const path = operand.replace(/::[\s\S]*$/, '');
    if (path === '' || path.startsWith('@') || /[$`~{\\]/.test(path)) return false;
    const base = cwdOf(state);
    if (base === null) return false;
    const abs = resolve(base, path);
    const root = projectRoot();
    let real = abs;
    try {
        real = realpathSync(abs); // follow symlinks of operands that exist
    } catch {
        // not on disk: judged by its text
    }
    return insideOrEqual(abs, root) && insideOrEqual(real, root);
}

function pytestRefusal(env, state) {
    const key = riskyVariable(env);
    if (key !== undefined) {
        return (
            `${key} is set; PYTEST_ADDOPTS and PYTEST_PLUGINS inject -p, PYTHONPATH/PYTHONSTARTUP and COVERAGE_RCFILE ` +
            'load code. Unset it.'
        );
    }
    if (!cwdInProject(state)) {
        return 'the working directory is not known to be inside the project, so pytest would collect conftest.py and plugins from elsewhere.';
    }
    return undefined;
}

function checkPytest(args, env, state) {
    const refusal = pytestRefusal(env, state);
    if (refusal !== undefined) return block(`Blocked: pytest: ${refusal}`);
    const { bad, operands } = parseOptions(args, PYTEST_OPTIONS, pytestExtra);
    if (bad !== undefined) {
        return block(
            `Blocked: \`pytest ${bad}\`; only reporting and selection options (-v -q -x -s -l -k -m -r --lf --ff --tb --maxfail ` +
                '--durations --collect-only --deselect --ignore --color --capture ...) are allowed. -p, --pyargs, -c/--config-file, ' +
                '--rootdir, -o/--override-ini, --confcutdir, --doctest-modules, --junitxml and --basetemp load code or write files.'
        );
    }
    const stray = operands.find((o) => !operandInProject(o, state));
    if (stray !== undefined) {
        return block(`Blocked: \`pytest ${stray}\`; test paths must be relative paths inside the project (no .., ~, $, @file, or absolute paths elsewhere).`);
    }
    return null;
}

const COVERAGE_RUN_OPTIONS = {
    '--branch': false,
    '-a': false,
    '--append': false,
    '-p': false,
    '--parallel-mode': false,
    '--source': null,
    '--include': null,
    '--omit': null,
};
const COVERAGE_REPORT_OPTIONS = {
    '--fail-under': /^\d+(\.\d+)?$/,
    '--show-missing': false,
    '-m': false,
    '--skip-covered': false,
    '--no-skip-covered': false,
    '--skip-empty': false,
    '--precision': /^\d$/,
    '--include': null,
    '--omit': null,
};
const COVERAGE_SUBCOMMANDS = ['run', 'report', 'erase', 'xml', 'html', 'json', 'lcov'];

function checkCoverage(args, env, state, words) {
    const sub = args[0];
    if (sub === undefined || !COVERAGE_SUBCOMMANDS.includes(sub)) {
        return block(
            `Blocked: \`coverage ${sub ?? ''}\`; only ${COVERAGE_SUBCOMMANDS.join('/')} are allowed, with no --rcfile ` +
                '(a coverage config can load plugin code) and no other global option.'
        );
    }
    const key = riskyVariable(env);
    if (key !== undefined) return block(`Blocked: \`coverage\` with ${key} set; COVERAGE_RCFILE and PYTHON*/PYTEST_* variables load code.`);
    const rest = args.slice(1);
    if (sub !== 'run') {
        const { bad, operands } = parseOptions(rest, COVERAGE_REPORT_OPTIONS);
        if (bad !== undefined || operands.length) {
            return block(`Blocked: \`coverage ${sub} ${bad ?? operands[0]}\`; only --fail-under, --show-missing, --skip-covered, --skip-empty, --precision, --include and --omit are allowed.`);
        }
        return null;
    }
    // coverage run [options] (-m MODULE | SCRIPT) [args]: judge the program as python would run it.
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '-m' || !a.startsWith('-')) return checkPython('python3', rest.slice(i), env, words, state);
        const name = a.split('=')[0];
        const rule = Object.hasOwn(COVERAGE_RUN_OPTIONS, name) ? COVERAGE_RUN_OPTIONS[name] : undefined;
        if (rule === undefined || (rule === false && a.includes('='))) {
            return block(`Blocked: \`coverage run ${a}\`; only --branch, --append, -p, --source, --include and --omit are allowed before the program.`);
        }
        if (rule === null && !a.includes('=')) i++;
    }
    return null;
}

/** `python3 -m MODULE`: modules that only read or compile. */
const PYTHON_READONLY_MODULES = new Set(['py_compile', 'compileall', 'unittest', 'json.tool', 'ast', 'tokenize', 'dis']);

/**
 * Source text a python/shell run from stdin would execute is judged by what
 * feeds it: a protected file read with `<` or piped, or a heredoc/here-string
 * or a literal echo/printf payload that names one.
 */
function stdinFeedsProtected(words) {
    const { pipedFrom, stdinFrom, hereString, heredocBody } = words;
    if (stdinFrom !== undefined && isProtected(stdinFrom)) return true;
    if (hereString !== undefined && extractSubstitutions(hereString).some(readsProtected)) return true;
    const texts = [heredocBody, hereString];
    for (let p = pipedFrom; p; p = p.pipedFrom) {
        if (segmentReadsProtected(p)) return true;
        texts.push(p.heredocBody, p.hereString, literalPayload(p));
    }
    return texts.some((t) => t !== undefined && PROTECTED_TEXT.test(t));
}

/** The text a literal `echo`/`printf` writes, or undefined for any other command. */
function literalPayload(f) {
    const name = basename(f[0] ?? '');
    if (name !== 'echo' && name !== 'printf') return undefined;
    const rest = f.slice(1).filter((a) => !a.startsWith('-'));
    if (name === 'printf') rest.shift(); // the format string
    return rest.join(' ');
}

function checkPython(cmd, args, env, words, state) {
    const key = riskyVariable(env);
    if (key !== undefined) {
        return block(`Blocked: \`${cmd}\` with ${key} set; PYTHON* variables (PYTHONPATH, PYTHONSTARTUP, ...) and PYTEST_*/COVERAGE_* can load code.`);
    }
    let module = null;
    let code = null;
    let i = 0;
    let rest = [];
    for (; i < args.length; i++) {
        const a = args[i];
        if (a === '--version' || a === '-V' || a === '--help' || a === '-h') return null;
        if (!a.startsWith('-') || a === '-') break;
        if (a === '--') {
            i++;
            break;
        }
        const cluster = /^-([BEIOPRSbdqsuvx]*)([mc])([\s\S]*)$/.exec(a);
        if (cluster) {
            const value = cluster[3] === '' ? (args[i + 1] ?? '') : cluster[3];
            rest = args.slice(cluster[3] === '' ? i + 2 : i + 1);
            if (cluster[2] === 'm') module = value;
            else code = value;
            break;
        }
        if (/^-[BEIOPRSbdqsuvx]+$/.test(a)) continue;
        if (a === '-W' || a === '-X') {
            i++;
            continue;
        }
        if (/^-[WX]./.test(a)) continue;
        return block(`Blocked: \`${cmd} ${a}\`; only the plain interpreter flags -B -E -I -O -s -S -u -v -x, -W/-X, -m and -c are allowed.`);
    }
    if (code !== null) {
        return PROTECTED_TEXT.test(code)
            ? block(`Blocked: \`${cmd} -c\` code names a protected script or the Tailscale API; it would run host-modifying code.`)
            : null;
    }
    if (module !== null) {
        if (module === 'pytest' || module === '_pytest') return checkPytest(rest, env, state);
        if (module === 'coverage') return checkCoverage(rest, env, state, words);
        if (PYTHON_READONLY_MODULES.has(module)) return null;
        if (PROTECTED_TEXT.test(module) || rest.some(isProtected)) {
            return block(`Blocked: \`${cmd} -m ${module}\` runs a protected script or names one.`);
        }
        return null;
    }
    const operand = args[i];
    if (operand === undefined || operand === '-') {
        // The program comes from stdin.
        return stdinFeedsProtected(words)
            ? block(`Blocked: \`${cmd}\` reads a protected script or the Tailscale API on stdin; it would run host-modifying code.`)
            : null;
    }
    if (isChecker(operand)) return checkUpstreamCheck(args.slice(i + 1), env, `Running ${operand}`);
    if (isProtected(operand)) return blockProtected(`\`${cmd} ${operand}\``);
    return null;
}

// ---------------------------------------------------------------------------
// Host-modifying commands
// ---------------------------------------------------------------------------

const PRIVILEGE = new Set(['sudo', 'doas', 'pkexec', 'run0', 'su', 'runuser']);
const CONTAINER_ENTER = new Set(['distrobox', 'distrobox-enter', 'distrobox-host-exec', 'toolbox']);
const CONTAINER_ENGINES = new Set(['podman', 'docker', 'nerdctl']);
const NET_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c']);
// Under xargs the command line gains words read at run time, which no check here
// sees. Only commands that are read-only whatever their arguments are may run under
// xargs; everything else (gh, git, node, python, the checker, curl, ...) is refused.
const XARGS_SAFE = new Set([
    'shellcheck', 'grep', 'egrep', 'fgrep', 'cat', 'wc', 'ls', 'head', 'tail', 'sort', 'uniq', 'echo', 'printf', 'true',
    'basename', 'dirname', 'stat', 'file',
]);
const XARGS_OPAQUE = (cmd) => !XARGS_SAFE.has(cmd);

// Scripts that change the live host or call the live Tailscale API.
const INSTALLERS = new Set(['install-dns-failover.sh', 'install-dns-failover', 'install.sh', 'in-container.sh']);
const CHECKERS = new Set(['dns-upstream-check.py', 'dns-upstream-check']);
// The installed copy of monitor.py is /usr/local/sbin/tailscale-dns-failover (tailscale-dns-failover/install.sh).
const PY_ONLY = new Set(['configure.py', 'monitor.py', 'tailscale-dns-failover']);
const isChecker = (word) => CHECKERS.has(basename(String(word)));
const PROTECTED_NAMES = [...INSTALLERS, ...CHECKERS, ...PY_ONLY];
/**
 * True for a protected script in any path form (`./monitor.py`,
 * `tailscale-dns-failover/install.sh`, ...), or for a word whose file name the
 * shell could expand into one: a pathname pattern that matches a protected
 * name (`monit?r.py`, `monitor.p*`, `inst[a]ll.sh`) or a brace expansion,
 * which can build any name (`mon{itor,x}.py`). The tokenizer has already
 * dropped quotes, so a quoted `*` counts too.
 */
export function isProtected(word) {
    const w = String(word);
    const name = basename(w);
    if (INSTALLERS.has(name) || CHECKERS.has(name) || PY_ONLY.has(name)) return true;
    const last = w.slice(w.lastIndexOf('/') + 1);
    if (/[{}]/.test(last)) return true;
    if (!/[*?[]/.test(last)) return false;
    return PROTECTED_NAMES.some((n) => globMatch(last, n));
}

/**
 * A pathname pattern as a regular expression that matches at least every
 * name the shell would match: `*` and `?` as in the shell, and a bracket
 * expression (with `[:class:]` parts and a leading `]` handled) as any one
 * character. An unclosed `[` is a literal, as in the shell.
 *
 * The shared globMatches() reads POSIX classes (`[[:alpha:]]`) since akmods
 * 9d62f85, but matches a set by its members; this reading stays because it is
 * broader: a set that bash could match by another rule (`[G]it` under
 * `shopt -s nocaseglob`, a range in a locale's collation order) still counts.
 */
function globMatch(pattern, text) {
    // Match a pathname pattern against one name in linear time, so an input
    // cannot blow the hook's time budget (a pattern of many `*` compiled to a
    // regexp — `.*.*.*…` — backtracks exponentially against a non-matching
    // name, and that regexp runs inside a single `.test()` call that the
    // per-step budget check in spend() can never interrupt, so the hook runs
    // past its timeout and Claude Code then runs the command unchecked). This
    // is the classic single-star-pointer algorithm: `*` matches any run, `?`
    // and a bracket expression match one character, every other character is
    // literal, and an unclosed `[` is literal — the same semantics the old
    // regexp gave.
    let p = 0;
    let t = 0;
    let star = -1;
    let afterStar = 0;
    const consumesOne = (i) =>
        pattern[i] === '?' || (pattern[i] === '[' && bracketEnd(pattern, i) !== -1);
    while (t < text.length) {
        if (p < pattern.length && consumesOne(p)) {
            p = pattern[p] === '[' ? bracketEnd(pattern, p) + 1 : p + 1;
            t++;
        } else if (p < pattern.length && pattern[p] === '*') {
            star = p;
            afterStar = t;
            p++;
        } else if (p < pattern.length && pattern[p] === text[t]) {
            p++;
            t++;
        } else if (star !== -1) {
            p = star + 1;
            afterStar++;
            t = afterStar;
        } else {
            return false;
        }
    }
    while (pattern[p] === '*') p++;
    return p === pattern.length;
}

/** Index of the `]` closing the bracket expression opened at `start`, or -1. */
function bracketEnd(pattern, start) {
    let j = start + 1;
    if (pattern[j] === '!' || pattern[j] === '^') j++;
    if (pattern[j] === ']') j++;
    while (j < pattern.length) {
        if (pattern[j] === '[' && ':=.'.includes(pattern[j + 1] ?? 'x')) {
            // An unclosed `[:` / `[=` / `[.` is no class: the shell takes the
            // `[` as one more member of the set (`[[:a]` matches `[`, `:` or `a`).
            const close = pattern.indexOf(`${pattern[j + 1]}]`, j + 2);
            j = close === -1 ? j + 1 : close + 2;
        } else if (pattern[j] === ']') {
            return j;
        } else {
            j++;
        }
    }
    return -1;
}
// Code text (python -c, a script piped to python) that names a protected script or the Tailscale API.
const PROTECTED_TEXT = /install[-_]dns[-_]failover|dns[-_]upstream[-_]check|\bmonitor\b|\bconfigure\b|in-container|tailscale\.com/i;
const TAILSCALE_API = /tailscale\.com/i;

/** True if a tokenized segment names a protected script as an argument or reads it with `<`. */
function segmentReadsProtected(seg) {
    return seg.some(isProtected) || (seg.stdinFrom !== undefined && isProtected(seg.stdinFrom));
}

/** True if a command line (a substitution body) reads or names a protected script. */
function readsProtected(commandLine) {
    return tokenize(commandLine).some(segmentReadsProtected);
}

function blockProtected(what) {
    return block(
        `Blocked: ${what} would execute an installer, configure.py or monitor.py (or dns-upstream-check.py against the host). ` +
            'These change /etc and systemd, write root-only credentials or call the live Tailscale API (monitor.py --dry-run included). ' +
            'Exercise the code with `python3 -m pytest` (fakes, temp dirs) or the tests/e2e container harness. ' +
            '`distrobox enter` / `toolbox run` reach the real container and never qualify.'
    );
}

/**
 * Real path of an absolute, non-expanding path, or null. Relative paths, `..`,
 * `$ ~ ` * ? [ { \` never qualify: the shell resolves them against its own
 * state, not the hook's.
 */
function realAbsolute(value) {
    if (!value || !isAbsolute(value) || /[$`~*?[{\\]/.test(value) || value.split('/').includes('..')) return null;
    try {
        return realpathSync(value);
    } catch {
        return null;
    }
}

/** The directories a dns-upstream-check run may use: the OS temp dir, /tmp, /var/tmp and the project's tests/. */
function scratchRoots() {
    const roots = new Set();
    for (const dir of [tmpdir(), '/tmp', '/var/tmp']) {
        try {
            roots.add(realpathSync(dir));
        } catch {
            // missing on this platform
        }
    }
    roots.add(join(projectRoot(), 'tests'));
    return [...roots];
}

const inScratch = (real) => scratchRoots().some((root) => strictlyInside(real, root));

function scratchDirOk(value) {
    const real = realAbsolute(value);
    if (real === null || !inScratch(real)) return false;
    try {
        return statSync(real).isDirectory();
    } catch {
        return false;
    }
}

/** The pid file may not exist yet; its parent must be a scratch dir, and an existing file must really be one inside it. */
function scratchPidFileOk(value) {
    if (!value || value.endsWith('/') || !isAbsolute(value) || /[$`~*?[{\\]/.test(value) || value.split('/').includes('..')) return false;
    if (!scratchDirOk(dirname(value))) return false;
    let real;
    try {
        real = realpathSync(value);
    } catch (err) {
        // Absent: fine. A dangling symlink also lands here, so look at the link itself.
        if (err.code !== 'ENOENT') return false;
        try {
            lstatSync(value);
            return false; // a link with no target
        } catch {
            return true; // absent: the checker creates it inside the verified directory
        }
    }
    try {
        return statSync(real).isFile() && inScratch(real);
    } catch {
        return false;
    }
}

const UPSTREAM_VALUE_OPTIONS = new Set(['--directory', '--pid-file', '--primary-port', '--backup-port']);

/**
 * dns-upstream-check.py rewrites /run/dns-upstream and SIGHUPs the real
 * dnsmasq. It is runnable only as `--no-reload --directory D --pid-file P`
 * with D and P inside scratch space (checked on disk), and no other option.
 */
function checkUpstreamCheck(args, env, what) {
    const key = riskyVariable(env);
    if (key !== undefined) return block(`Blocked: ${what} with ${key} set; PYTHON* variables can load code into the checker.`);
    let noReload = false;
    let helpOnly = false;
    const directories = [];
    const pidFiles = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const m = /^(--[a-z-]+)=([\s\S]*)$/.exec(a);
        const name = m ? m[1] : a;
        if (name === '--no-reload' && !m) noReload = true;
        else if ((name === '-h' || name === '--help') && !m) helpOnly = true;
        else if (UPSTREAM_VALUE_OPTIONS.has(name)) {
            const value = m ? m[2] : args[++i];
            if (value === undefined) return blockUpstream(what, `${name} has no value`);
            if (name === '--directory') directories.push(value);
            else if (name === '--pid-file') pidFiles.push(value);
            else if (!/^\d+$/.test(value)) return blockUpstream(what, `${name} must be a number`);
        } else {
            return blockUpstream(what, `\`${a}\` is not one of the options spelled in full: --no-reload --directory --pid-file --primary-port --backup-port`);
        }
    }
    if (helpOnly && !noReload && !directories.length && !pidFiles.length) return null;
    if (!noReload) return blockUpstream(what, 'it is missing --no-reload (it would SIGHUP the real dnsmasq)');
    if (!directories.length || !pidFiles.length) return blockUpstream(what, 'it needs both --directory and --pid-file');
    const badDir = directories.find((d) => !scratchDirOk(d));
    if (badDir !== undefined) return blockUpstream(what, `--directory ${badDir} is not an existing directory inside the temp dir, /tmp, /var/tmp or tests/`);
    const badPid = pidFiles.find((p) => !scratchPidFileOk(p));
    if (badPid !== undefined) return blockUpstream(what, `--pid-file ${badPid} is not a file inside the temp dir, /tmp, /var/tmp or tests/`);
    return null;
}

function blockUpstream(what, why) {
    return block(
        `Blocked: ${what}: ${why}. dns-upstream-check.py may run only with --no-reload and absolute --directory/--pid-file ` +
            'paths (no .., ~, $) that exist inside the OS temp dir, /tmp, /var/tmp or this project\'s tests/; the real one writes /run/dns-upstream and SIGHUPs dnsmasq.'
    );
}

/** `distrobox enter`, `toolbox run|enter`: the real container, always refused; `distrobox-host-exec cmd`: cmd is analysed as running for real. */
function checkContainerEnter(cmd, args, state) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (cmd === 'distrobox-enter' || (cmd === 'distrobox' && sub === 'enter') || (cmd === 'toolbox' && (sub === 'run' || sub === 'enter'))) {
        return block(`Blocked: \`${cmd}${sub ? ` ${sub}` : ''}\` enters the developer's real long-lived container; use \`podman run\` of tests/e2e instead.`);
    }
    if (cmd !== 'distrobox-host-exec') return null; // other distrobox/toolbox subcommands (create, list, ephemeral, ...) run nothing of ours
    const at = args.findIndex((a) => !a.startsWith('-'));
    const inner = at === -1 ? [] : args.slice(at);
    if (!inner.length) {
        return block('Blocked: `distrobox-host-exec` with no command starts a shell on the host, which runs whatever reaches its stdin; name the command to run.');
    }
    return checkSegment(inner, Object.assign(Object.create(state), { cwd: null }));
}

// systemd subcommands that only read. Anything else (start, stop, restart,
// reload, enable, disable, mask, kill, daemon-reload, edit, link, ...) changes state.
const SYSTEMCTL_READONLY = new Set([
    'status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'list-units', 'list-unit-files', 'list-timers',
    'list-sockets', 'list-dependencies', 'list-jobs', 'list-machines', 'get-default', 'is-system-running',
    'show-environment', 'help',
]);
// Names of the units and daemons this project manages.
const MANAGED_UNIT = /dnsmasq|stubby|dns-upstream|dns-failover/i;

function checkSystemctl(args) {
    const { sub } = firstWord(args, [
        '-H', '--host', '-M', '--machine', '-p', '--property', '-t', '--type', '-s', '--signal', '-n', '--lines', '-o', '--output',
        '--state', '--root', '--kill-whom', '--kill-who', '--job-mode', '--reason', '--message', '-T',
    ]);
    if (sub === undefined || SYSTEMCTL_READONLY.has(sub)) return null;
    const otherScope = args.some((a) => /^(--system|--global|--root|--host|--machine)(=|$)/.test(a) || /^-[HM]/.test(a));
    if (args.includes('--user') && !otherScope && !args.some((a) => MANAGED_UNIT.test(a))) return null;
    return block(
        `Blocked: \`systemctl ${sub}\` changes system state or touches dnsmasq/stubby/this project's units on the host. ` +
            'Only read-only subcommands (status, is-active, show, list-*, ...) and --user changes to unrelated user units are allowed.'
    );
}

function checkService(args) {
    // Only the standalone `service --status-all` is read-only. `service NAME ACTION`
    // (even `status`) and any extra word beside --status-all (`service dnsmasq
    // restart --status-all`) are refused.
    if (args.length === 1 && args[0] === '--status-all') return null;
    return block('Blocked: `service` is only allowed as exactly `service --status-all`; any other form can start, stop or reload system services (dnsmasq, stubby) on the host.');
}

// Options a throwaway `run`/`create` may carry before the image. Anything else is
// refused (--privileged, --volumes-from, --pid/--network/--ipc/--uts/--userns=host,
// --cap-add, --device, --security-opt, ...): --network=host would collide with the
// host's real Stubby listeners on 127.0.0.1:5453/5454 and --pid=host would let
// dns-upstream-check.py signal the host's dnsmasq. Value: false = flag, null = a value.
const CONTAINER_RUN_OPTIONS = {
    '--rm': false, '-i': false, '-t': false, '-it': false, '-ti': false, '--interactive': false, '--tty': false,
    '-w': null, '--workdir': null, '-e': null, '--env': null, '--name': null,
    '-v': null, '--volume': null, '--mount': null,
};

function checkContainerRun(cmd, sub, args, state) {
    const at = args.indexOf(sub);
    const opts = [];
    for (let i = at + 1; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('-') || a === '-') break; // the image: everything after it is the container's command
        const eq = a.indexOf('=');
        const name = a.startsWith('--') && eq !== -1 ? a.slice(0, eq) : a;
        const attached = /^-[vwe]./.test(a) ? a.slice(0, 2) : null;
        const key = attached ?? name;
        if (!Object.hasOwn(CONTAINER_RUN_OPTIONS, key)) {
            const why = /^--privileged/.test(a) ? 'gives the container the host; the e2e harness needs no privileges' :
                `is not on the allowlist (${Object.keys(CONTAINER_RUN_OPTIONS).join(' ')}); it could share the host's namespaces, volumes or devices`;
            return block(`Blocked: \`${cmd} ${sub} ${a}\` ${why}.`);
        }
        if (CONTAINER_RUN_OPTIONS[key] === null) {
            if (attached) opts.push(a);
            else if (a.startsWith('--') && eq !== -1) opts.push(a);
            else {
                if (args[i + 1] === undefined) return block(`Blocked: \`${cmd} ${sub} ${a}\` has no value.`);
                opts.push(a, args[++i]);
            }
        } else opts.push(a);
    }
    const mount = hostMountRefusal(opts, state);
    if (mount !== undefined) {
        return block(`Blocked: \`${cmd} ${sub}\` mounts ${mount || '(unparseable)'} from the host; only the project (or temp dirs) may be mounted.`);
    }
    return null;
}

/** dnsmasq and stubby run only to validate a configuration and exit. */
function checkDaemon(cmd, args) {
    const valueOpt = cmd === 'dnsmasq' ? ['-C', '--conf-file'] : ['-C'];
    const check = cmd === 'dnsmasq' ? ['--test', '--version', '--help', '-v', '-h'] : ['-i', '-V', '-h'];
    let checking = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (check.includes(a)) checking = true;
        else if (valueOpt.includes(a)) {
            if (args[++i] === undefined) return blockDaemon(cmd);
        } else if (!(cmd === 'dnsmasq' && /^--conf-file=./.test(a)) && !(/^-C./.test(a))) return blockDaemon(cmd);
    }
    return checking ? null : blockDaemon(cmd);
}

function blockDaemon(cmd) {
    const ok = cmd === 'dnsmasq' ? '`dnsmasq --test [--conf-file FILE]`' : '`stubby -i [-C FILE]`';
    return block(`Blocked: running \`${cmd}\` would start (or signal) the host's DNS daemon; only ${ok} (validate and exit), --version and --help are allowed.`);
}

const TAILSCALE_READONLY = ['status', 'version', 'ip', 'ping', 'netcheck', 'whois', 'help'];

function checkTailscale(args) {
    const { sub } = firstWord(args, ['--socket']);
    if (sub === undefined || TAILSCALE_READONLY.includes(sub)) return null;
    return block(
        `Blocked: \`tailscale ${sub}\` can change the tailnet or this node's DNS settings (the change monitor.py makes); only ${TAILSCALE_READONLY.join('/')} are allowed.`
    );
}

function checkNetClient(cmd, args) {
    const named = args.find((a) => TAILSCALE_API.test(a));
    if (named !== undefined) return block(`Blocked: \`${cmd} ${named}\` is a Tailscale API call; agents never call it (it needs real credentials and can change the tailnet's DNS).`);
    // A URL list in a file is invisible here.
    const hidden = args.find((a) =>
        cmd === 'curl' ? /^-[a-zA-Z]*K/.test(a) || a === '--config' || a.startsWith('--config=')
            : cmd === 'wget' ? /^-[a-zA-Z]*[ie]/.test(a) || /^--(input-file|config|execute)(=|$)/.test(a)
                : false
    );
    if (hidden !== undefined) return block(`Blocked: \`${cmd} ${hidden}\` reads URLs or settings from a file this hook cannot inspect (it could hold api.tailscale.com).`);
    return null;
}

/**
 * Host paths a throwaway container must not be given. Only the project, scratch
 * space and named volumes are fine. A source the shell would expand (`~`, `$VAR`
 * other than a bare `$PWD`, globs) or resolve against the working directory
 * (`$PWD`, `.`, a relative path) is judged by where that directory really is:
 * `cd /etc && podman run -v "$PWD":/etc ...` mounts the host's /etc.
 */
function hostMountRefusal(args, state) {
    const sources = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        let value = null;
        if (a === '-v' || a === '--volume' || a === '--mount') value = args[++i] ?? '';
        else if (a.startsWith('--volume=') || a.startsWith('--mount=')) value = a.slice(a.indexOf('=') + 1);
        else if (/^-v./.test(a)) value = a.slice(2);
        if (value === null) continue;
        if (/(^|,)type=/.test(value) || /(^|,)(source|src)=/.test(value)) {
            sources.push(...[...value.matchAll(/(?:^|,)(?:source|src)=([^,]*)/g)].map((m) => m[1]));
        } else sources.push(value.split(':')[0]);
    }
    const root = projectRoot();
    return sources.find((src) => {
        if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(src) && !src.startsWith('.')) return false; // a named volume
        if (src.startsWith('/')) {
            const real = realAbsolute(src);
            return real === null || !(insideOrEqual(real, root) || inScratch(real));
        }
        // Relative to the shell's directory: `$PWD`, `${PWD}`, `.`, `./x`, `x/y`.
        const rel = src.replace(/^\$\{?PWD\}?(?=\/|$)/, '.');
        if (/[$`~*?[{\\]/.test(rel) || rel.split('/').includes('..') || !cwdInProject(state)) return true;
        const abs = resolve(cwdOf(state), rel);
        let real = abs;
        try {
            real = realpathSync(abs);
        } catch {
            // not on disk: judged by its text
        }
        return !(insideOrEqual(abs, root) && insideOrEqual(real, root));
    });
}

// ---------------------------------------------------------------------------
// Segment / command analysis
// ---------------------------------------------------------------------------

/**
 * `find ... -exec|-execdir|-ok|-okdir CMD ARGS ;` (or `{} +`) runs CMD for each
 * file: analyse each such command like a segment of its own. -execdir and
 * -okdir run it from the directory of each file, so its directory is unknown.
 */
function checkFindExec(args, state) {
    for (let i = 0; i < args.length; i++) {
        if (!FIND_EXEC.includes(args[i])) continue;
        let end = i + 1;
        while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++;
        const st = Object.assign(Object.create(state), args[i].endsWith('dir') ? { cwd: null } : {});
        const r = checkSegment(args.slice(i + 1, end), st);
        if (r) return r;
        i = end;
    }
    return null;
}

/** Where `cd DIR` leaves the shell: DIR if it is plainly inside the project, else null (unknown). */
function cdTarget(args, state) {
    const target = args.find((a) => !a.startsWith('-'));
    const base = cwdOf(state);
    if (target === undefined || target === '-' || base === null || /[$`~{*?[\\]/.test(target)) return null;
    const dir = resolve(base, target);
    let real = dir;
    try {
        real = realpathSync(dir);
    } catch {
        // judged by its text
    }
    return insideOrEqual(real, projectRoot()) ? dir : null;
}

const DAEMON_NAMES = new Set(['dnsmasq', 'stubby', 'tailscaled']);

// Every name checkSegment() checks or looks through, with the python and
// pytest spellings a wildcard is matched against (isPython() and isPytest()
// also take every version spelled out, such as python3.11).
const CHECKED_NAMES = new Set([
    ...PRIVILEGE, 'gh', 'git', 'node', 'nodejs', 'eval', 'source', 'coverage', 'systemctl', 'service', 'dnsmasq', 'stubby',
    'tailscale', 'tailscaled', 'pkill', 'killall', 'systemd-run', 'flatpak-spawn', 'watch', 'flock', 'find',
    ...SHELLS, ...CONTAINER_ENTER, ...CONTAINER_ENGINES, ...NET_CLIENTS,
    'python', 'python3', 'pypy3', 'pytest', 'py.test',
]);
// How the shell may build one of those names out of a word (brace groups,
// wildcards); see commandNameReader() in shell-reader.mjs.
const { builtCommandName } = commandNameReader(CHECKED_NAMES);

/** Whether this word names a command checkSegment() checks or looks through. */
function namesCheckedOrDaemon(a) {
    const name = basename(a);
    return CHECKED_NAMES.has(name) || isPython(name) || isPytest(name);
}

// Behind a program this hook does not list, a wildcard that fits more of the
// names than this is a list of files (`ls tests/*`, `wc -l docs/s*`); as a
// command it would run whichever file sorts first, not the checked one.
const MAX_GLOB_NAMES = 4;

/**
 * The checked names the shell could run from this word although the word
 * spells none of them out (#124), as { braces, names }. `names` holds each
 * checked name a brace form of the word is (`{git,}`, `g{i,x}t`) or a
 * wildcard in it can match (`/usr/bin/g?t`, and a bare `g?t`, which runs git
 * once a file named git sits in the working directory). `braces` is true when
 * brace expansion is how the word gets there, and also when the word has more
 * brace forms than the shared reader expands (MAX_BRACE_FORMS), so it may
 * build any of them. Both are empty for a plain word.
 *
 * The reading is the shared builtCommandName(), with this guard's stricter
 * readings kept on top of it: a brace form also counts when it is a python or
 * pytest version the list does not spell out (`{python3.11,}`,
 * `python3.1{1..1}`); the word with
 * its braces and commas taken out counts as one more form; and a wildcard is
 * matched with globMatch(), which reads a bracket expression as any one
 * character (so `[[:alpha:]]it` and `[!x]it` count as git), and reads a word
 * made only of `*` and `?` as every name it fits.
 */
export function builtNames(word, commandWord = false) {
    if (!/[{}*?[]/.test(word)) return { braces: false, names: [] };
    const shared = builtCommandName(word, commandWord);
    const found = new Set(shared?.globs);
    // Every brace form the shared reader makes: comma groups, sequences
    // (`python3.1{1..1}` is python3.11) and groups bash leaves as written.
    const forms = braceForms(word) ?? [word];
    if (/[{}]/.test(word)) forms.push(word.replace(/[{},]/g, ''));
    for (const form of forms) {
        if (!form || /\s/.test(form)) continue; // a word with a space in it names no program
        if (form !== word && namesCheckedOrDaemon(form)) found.add(basename(form));
        const last = form.slice(form.lastIndexOf('/') + 1);
        if (!/[*?[]/.test(last)) continue;
        for (const name of CHECKED_NAMES) if (globMatch(last, name)) found.add(name);
    }
    const names = [...found];
    return { braces: Boolean(shared?.braces) || (names.length > 0 && /[{}]/.test(word)), names };
}

/**
 * For a segment whose command is a program this hook neither checks nor steps
 * over (`setarch x86_64 git diff ...`, `prlimit ...`, `script -qc '...'`), the
 * refusal for the checked command it would run, or null. Each later word that
 * names a checked command is checked from there to the end, with the
 * assignments in front of the program, and each command string a later word
 * carries is checked as a command line of its own. A command that passes alone
 * still passes behind any program. Only over-refusing is guessed at: an option
 * value that reads as a checked command (`uname -- git diff --no-index a b`)
 * is refused too. A protected script named behind such a program is not read:
 * the hook cannot tell `cat install.sh` from a program that runs it.
 */
function checkUnlistedProgram(w, inlineEnv, state) {
    const cmd = w[0];
    if (ARGUMENT_ONLY_PROGRAMS.has(cmd)) return null;
    // Behind a look-up tool (`pgrep -a dnsmasq`, `journalctl -u stubby`) a
    // daemon's name is what it looks up, so it is not read as a command there.
    // Behind any other program it is, in a later word and in a command string.
    const lookup = DAEMON_LOOKUP_PROGRAMS.has(cmd);
    const skipped = (name) => lookup && DAEMON_NAMES.has(name);
    const namesCheckedCommand = (a) => !skipped(basename(a)) && namesCheckedOrDaemon(a);
    // The checked names braces or a wildcard in a path build (#124). Braces
    // are read as written: checkSegment() refuses them. A wildcard is read as
    // each name it fits, unless it fits so many that it is a list of files.
    // `commandWord` reads the word as one the shell runs (see builtNames()).
    const builtCommand = (a, commandWord = false) => {
        const { braces, names } = builtNames(a, commandWord);
        const kept = names.filter((name) => !skipped(name));
        // Too many brace forms to read (no names): it may build any checked name.
        if (braces && (kept.length || !names.length)) return [a];
        return kept.length <= MAX_GLOB_NAMES ? kept : [];
    };
    const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
    let checked = 0;
    for (let n = 1; n < w.length; n++) {
        spend();
        let refusal = null;
        const readings = namesCheckedCommand(w[n]) ? [w[n]] : builtCommand(w[n]);
        if (readings.length) {
            if (++checked > MAX_UNLISTED_INNER) {
                return block(
                    `Blocked: more than ${MAX_UNLISTED_INNER} commands this hook checks behind \`${basename(cmd)}\`, ` +
                        'too many to read. Run them as commands of their own.'
                );
            }
            let start = n;
            while (start > 1 && isAssignment(w[start - 1])) start--;
            for (const name of readings) {
                refusal = checkSegment([...env, ...w.slice(start, n), name, ...w.slice(n + 1)], Object.create(state));
                if (refusal) break;
            }
        }
        if (!refusal) {
            for (const text of commandStrings(w[n])) {
                spend();
                const named = (piece) => Boolean(piece) && (namesCheckedCommand(piece) || builtCommand(piece).length > 0);
                const names = (t) => t.split(COMMAND_STRING_SEPARATORS).some(named);
                // The words as the shell reads them: `$'\x67it'` decoded, `{git,}` kept whole,
                // and the first word of each command in it as one the shell runs (`* push`).
                const read = () =>
                    tokenize(text).some((seg) => seg.some(named) || (seg.length > 0 && builtCommand(seg[0], true).length > 0));
                // A `$'...'` string the reader may misread is checked (and refused) too.
                if (!names(text) && !names(unquoted(text)) && !read() && !MISREAD_ANSI_C.test(text)) continue;
                refusal = checkCommand(text, Object.create(state));
                if (refusal) break;
            }
        }
        if (refusal) {
            return {
                ...refusal,
                reason:
                    `\`${basename(cmd)}\` runs a command that is refused on its own, and bypass and auto modes ` +
                    `prompt for neither, so it is checked as though it stood alone. ${refusal.reason}`,
            };
        }
    }
    return null;
}

function checkSegment(words, state) {
    spend();
    const { pipedFrom, stdinFrom, hereString, heredocBody } = words;
    let w = words.slice();
    const inlineEnv = {};
    // A chdir wrapper (`env -C DIR`) moves the command out of the shell's directory.
    let chdir = false;
    // Set once the segment runs through xargs: xargs appends words it reads at
    // run time, so no argument check below sees the real command line.
    let xargsFed = false;
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]) || w[0] === 'function' || w[0] === 'coproc')) {
            if (isAssignment(w[0])) {
                const eq = w[0].indexOf('=');
                inlineEnv[w[0].slice(0, eq)] = w[0].slice(eq + 1);
            }
            // `function NAME { CMD; }`: the body follows the name. `coproc NAME { CMD; }`
            // names a compound command; `coproc CMD` runs CMD.
            if (w[0] === 'function' || (w[0] === 'coproc' && w[2] === '{')) w.shift();
            w.shift();
        }
        if (!w.length) return null;
        // A command name the shell builds into a checked one (#124). Braces are
        // refused: `{git,diff} --no-index a b` is `git diff --no-index a b`, and
        // the words they add are not modelled. A wildcard in a path is read as
        // the one checked program it can match, so the rules below apply to it.
        const built = builtNames(w[0], true);
        if (built.braces) {
            const reach = built.names.length
                ? `can expand to \`${built.names[0]}\`, which this hook checks`
                : 'has more brace forms than this hook reads, so it can expand to any command this hook checks';
            return block(
                `Blocked: \`${w[0]}\` is a command name the shell expands with its braces before running it, and it ` +
                    `${reach} only when the name is spelled out. Spell the name out.`
            );
        }
        if (built.names.length > 1) {
            return block(
                `Blocked: \`${w[0]}\` is a wildcard the shell matches against the disk before running it, and it can ` +
                    `match ${built.names.map((n) => `\`${n}\``).join(', ')}, which this hook checks. Spell the name out.`
            );
        }
        if (built.names.length) w = [built.names[0], ...w.slice(1)];
        const cmd = basename(w[0]);
        if (PRIVILEGE.has(cmd)) {
            return block(`Blocked: \`${cmd}\` (privilege escalation) is never run by agents in this repository.`);
        }
        if (!WRAPPERS.has(cmd)) break;
        w = expandWrapperOptions(cmd, w);
        // `env -S 'gh pr create'` / `--split-string=...` runs a command string.
        // Only env's own leading options and NAME=value words are scanned; the
        // wrapped command's arguments (e.g. `--title -Sx`) are not env options.
        if (cmd === 'env') {
            for (let k = 1; k < w.length; k++) {
                const a = w[k];
                if (isAssignment(a)) continue;
                if (!a.startsWith('-')) break; // first word of the wrapped command
                if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(a)) {
                    if (a === '-C' || a === '--chdir') chdir = true;
                    k++;
                    continue;
                }
                if (/^-C./.test(a) || a.startsWith('--chdir=')) chdir = true;
                let script = null;
                let rest = k + 1;
                if (a === '-S' || a === '--split-string') {
                    script = w[k + 1] ?? '';
                    rest = k + 2;
                } else if (a.startsWith('--split-string=')) script = a.slice(15);
                else if (/^-S./.test(a)) script = a.slice(2);
                if (script === null) continue;
                // Check the string on its own, then as the head of the command
                // that still has the remaining words appended.
                const alone = checkCommand(script, state);
                if (alone) return alone;
                const head = tokenize(script).flat();
                return checkSegment([...head, ...w.slice(rest)], state);
            }
        }
        // Look through the wrapper to the command it runs: skip its own options
        // (and their values), NAME=value words, and operands such as timeout's duration.
        const idx = wrapperTarget(w);
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) {
            if (isAssignment(x)) {
                const eq = x.indexOf('=');
                inlineEnv[x.slice(0, eq)] = x.slice(eq + 1);
            }
        }
        if (idx === -1) return null;
        // chroot changes to its new root, nsenter can enter another mount namespace
        // or working directory, and unshare -w/--wd/-R/--root moves too.
        if (cmd === 'chroot' || cmd === 'nsenter') chdir = true;
        if (cmd === 'unshare' && w.slice(1, idx).some((a) => /^(?:-[wR]|--wd|--root)(?:=|$)|^-[wR]./.test(a))) chdir = true;
        // `watch CMD...` joins its words and runs them with `sh -c` (with -x it runs
        // them directly; the words are also looked through below, so both readings
        // are checked). `flock FILE -c CMD` runs CMD with `sh -c`.
        const inner = () => Object.assign(Object.create(state), chdir ? { cwd: null } : {});
        if (cmd === 'watch') {
            const r = checkCommand(w.slice(idx).join(' '), inner());
            if (r) return r;
        } else if (cmd === 'flock' && (w[idx] === '-c' || w[idx] === '--command')) {
            return checkCommand(w[idx + 1] ?? '', inner());
        }
        if (cmd === 'xargs') xargsFed = true;
        w = w.slice(idx);
    }

    const cmd = basename(w[0]);
    const args = w.slice(1);
    // `printf '%s\n' --output=FILE | xargs git log`, `printf '%s\n' +n -c CMD | xargs bash -n`
    // and `echo https://api.tailscale.com/... | xargs curl` reach commands with
    // arguments this hook never sees, under the allow rules and checks below.
    if (xargsFed && XARGS_OPAQUE(cmd) && !PRIVILEGE.has(cmd)) {
        return block(
            `Blocked: \`xargs ${cmd}\`; xargs adds arguments read at run time, so this hook cannot check the ` +
                `${cmd} command line the allow rules pre-approve. Write the ${cmd} command out in full instead.`
        );
    }
    // A command run from another directory (env -C, or an earlier cd out of the project) is not "in the project".
    const here = chdir ? Object.assign(Object.create(state), { cwd: null }) : state;
    // Nested analysis (`bash -c '...'`, `eval`) sees this segment's directory, but
    // anything it changes stays inside it, as in a real subshell.
    const nested = () => Object.create(here);
    const env = { ...(state.exportedEnv ?? {}), ...inlineEnv };

    if (cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && args.some((a) => /^-[a-zA-Z]*x/.test(a)))) {
        for (const a of args) {
            if (a.startsWith('GH_REPO=')) state.exportedGhRepo = a.slice(8);
            // `export GH_REPO+=X` appends to a value this hook may not know: no known repository.
            if (a.startsWith('GH_REPO+=') && a !== 'GH_REPO+=') state.exportedGhRepo = null;
            // `export NAME` without a value exports an earlier assignment: value unknown (null).
            // `export NAME+=value` appends to NAME; it is kept as `NAME+`, which riskyEnv() reads as NAME.
            const eq = a.indexOf('=');
            const name = eq === -1 ? a : a.slice(0, eq);
            const base = name.endsWith('+') ? name.slice(0, -1) : name;
            if (/^(GIT_CONFIG_|GIT_SSH)/i.test(base) || WATCHED_ENV.test(base) || PYTHON_ENV.test(base)) {
                (state.exportedEnv ??= {})[name] = eq === -1 ? null : a.slice(eq + 1);
            }
        }
        return null;
    }
    if (cmd === 'cd' || cmd === 'pushd') {
        state.cwd = cdTarget(args, state);
        return null;
    }
    if (cmd === 'popd') {
        state.cwd = null;
        return null;
    }
    if (cmd === 'gh') {
        // `GH_REPO+=X gh ...` (an assignment the shared reader reads since akmods
        // 9d62f85) appends to a value this hook may not know: no known repository.
        const appended = Object.hasOwn(inlineEnv, 'GH_REPO+') && inlineEnv['GH_REPO+'] !== '';
        const envRepo = appended ? null : (inlineEnv.GH_REPO ?? state.exportedGhRepo ?? null);
        return checkGh(args, envRepo);
    }
    if (cmd === 'git') return checkGit(args, inlineEnv, state.exportedEnv ?? {});
    if (cmd === 'node' || cmd === 'nodejs') return checkNode(cmd, args, env);
    if (isPython(cmd)) return checkPython(cmd, args, env, words, here);
    if (isPytest(cmd)) return checkPytest(args, env, here);
    if (cmd === 'coverage') return checkCoverage(args, env, here, words);
    if (isChecker(w[0])) return checkUpstreamCheck(args, env, `Running ${w[0]}`);
    if (isProtected(w[0])) return blockProtected(`Running ${w[0]}`);
    if (cmd === 'source' || cmd === '.') {
        return args.some(isProtected) ? blockProtected(`Sourcing ${args.find(isProtected)}`) : null;
    }
    if (cmd === 'find') return checkFindExec(args, here);
    if (SHELLS.has(cmd)) {
        // `bash -n` is pre-approved in .claude/settings.json because -n parses a
        // script without running it, but a later `+n` or `+o noexec` turns -n off
        // again: `bash -n +n -c 'cmd'` runs cmd with no prompt. Refuse any word
        // beginning with + in a -n invocation, and any word bash could rewrite
        // into one first (`{+,+}n`, `?n` beside a file named +n, `$X`).
        if (args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) {
            const bad = args.find((a) => a.startsWith('+') || /[{}*?[$`]/.test(a));
            if (bad !== undefined) {
                return block(
                    `Blocked: \`${cmd} -n ... ${bad}\`; -n only parses a script, and +n or +o noexec turns that off ` +
                        'so the command would run under the syntax-check allow rule. Check syntax with `bash -n FILE` only; ' +
                        'run a script as itself so the permission rules see it.'
                );
            }
        }
        // fish takes code from -c/--command and -C/--init-command (each may repeat,
        // with the value attached or in the next word); every one of them runs.
        // Other shells run the first non-option word after -c
        // (`sh -c -- 'cmd'`, `sh -c -x 'cmd'`).
        let scripts;
        if (cmd === 'fish') scripts = fishScripts(args);
        else {
            const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
            const script = c === -1 ? undefined : args.slice(c + 1).find((a) => !a.startsWith('-'));
            scripts = script === undefined ? [] : [script];
        }
        for (const script of scripts) {
            // `bash -c "$(cat install.sh)"`: the whole script text is the installer.
            if (/^\$\([\s\S]*\)$|^`[\s\S]*`$/.test(script.trim()) && extractSubstitutions(script).some(readsProtected)) {
                return blockProtected(`\`${cmd} -c\` reading a protected script`);
            }
            const r = checkCommand(script, nested());
            if (r) return r;
        }
        if (scripts.length) return null;
        // `bash -n file` only parses the file; any other shell invocation runs it.
        const syntaxOnly = args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
        const target = args.find(isProtected);
        if (!syntaxOnly && target !== undefined) return blockProtected(`\`${cmd} ${target}\``);
        // No script operand: the shell reads its program from stdin
        // (`cat install.sh | bash`, `bash -s < install.sh`).
        if (!syntaxOnly && !args.some((a) => !a.startsWith('-'))) {
            const feeders = [];
            for (let p = pipedFrom; p; p = p.pipedFrom) feeders.push(p);
            // `bash <<< "$(cat install.sh)"`: the here-string expands to the installer.
            const reads =
                (hereString !== undefined && extractSubstitutions(hereString).some(readsProtected)) ||
                (stdinFrom !== undefined && isProtected(stdinFrom)) ||
                feeders.some(segmentReadsProtected);
            if (reads) return blockProtected(`\`${cmd}\` reading a protected script on stdin`);
            // A heredoc or here-string fed to a shell is a script it runs.
            // The same holds for text piped in (`cat <<'EOF' | bash`).
            // A literal `echo`/`printf` payload piped in is a script too.
            for (const text of [heredocBody, hereString, ...feeders.flatMap((f) => [f.heredocBody, f.hereString, literalPayload(f)])]) {
                if (text === undefined) continue;
                const r = checkCommand(text, nested());
                if (r) return r;
            }
        }
        return null;
    }
    if (cmd === 'eval') return checkCommand(args.join(' '), nested());
    if (cmd === 'systemctl') return checkSystemctl(args);
    if (cmd === 'service') return checkService(args);
    if (cmd === 'dnsmasq' || cmd === 'stubby') return checkDaemon(cmd, args);
    if (cmd === 'tailscaled') return block('Blocked: `tailscaled` is the host\'s Tailscale daemon; agents never start it.');
    if (cmd === 'tailscale') return checkTailscale(args);
    if (cmd === 'pkill' || cmd === 'killall') {
        return args.some((a) => MANAGED_UNIT.test(a))
            ? block(`Blocked: \`${cmd}\` of dnsmasq/stubby would stop or signal the host's DNS daemons.`)
            : null;
    }
    if (NET_CLIENTS.has(cmd)) return checkNetClient(cmd, args);
    if (cmd === 'systemd-run' || cmd === 'flatpak-spawn') {
        // They run a command outside this shell's cwd: look through to it.
        const isInteresting = (a) => isProtected(a) || namesCheckedOrDaemon(a);
        const at = args.findIndex(isInteresting);
        if (at !== -1) {
            const r = checkSegment(args.slice(at), Object.assign(Object.create(state), { cwd: null }));
            if (r) return r;
        }
        const target = args.find(isProtected);
        return target === undefined ? null : blockProtected(`\`${cmd} ${target}\``);
    }
    if (CONTAINER_ENTER.has(cmd)) return checkContainerEnter(cmd, args, state);
    if (CONTAINER_ENGINES.has(cmd)) {
        // `docker container exec ...` / `podman container run ...` are the long
        // forms of `exec` / `run`; judge them the same way.
        // Global options take values (`docker --host unix:///... exec`), so the
        // subcommand cannot be located by position: any word that is exactly
        // exec/attach (or run/create) counts. Fail closed.
        const sub = ['exec', 'attach', 'run', 'create'].find((word) => args.includes(word));
        // `exec`/`attach` reach long-lived containers, including the distrobox
        // container (distrobox containers are podman containers).
        if (sub === 'exec' || sub === 'attach') {
            return block(`Blocked: \`${cmd} ${sub}\` enters an existing container, possibly the real distrobox one; use \`${cmd} run\` with a throwaway container.`);
        }
        if (sub === 'run' || sub === 'create') {
            const refused = checkContainerRun(cmd, sub, args, here);
            if (refused) return refused;
        }
        // A container run that names a protected script is exempt only when it
        // is the e2e harness (a path containing tests/e2e).
        const named = args.find(isProtected);
        if (named !== undefined && !args.some((a) => /(^|\/)tests\/e2e(\/|$)/.test(a))) {
            return block(`Blocked: \`${cmd}\` with ${named} is not the tests/e2e harness; container runs of the installers are only allowed via tests/e2e.`);
        }
        return null;
    }
    return checkUnlistedProgram(w, inlineEnv, state);
}


/**
 * True if a segment may change the working directory in a way checkSegment()
 * does not follow: the shared changesDirectory() reads it as a cd, pushd or
 * popd, but its command word is not one of them spelled out (`eval cd DIR`,
 * `{cd,} DIR`, `c? DIR`, `$X DIR`). A plain `cd DIR` is followed by cdTarget().
 */
function untrackedDirectoryChange(words) {
    if (!changesDirectory(words)) return false;
    const k = words.findIndex((x) => !(isAssignment(x) || KEYWORDS.has(x) || WRAPPERS.has(basename(x)) || x.startsWith('-')));
    return k === -1 || !CHDIR.has(words[k]);
}

// `$'...'` strings whose end is easy to misplace: one holding an escaped quote
// (`$(printf $'\'') ...`), or `\c` before a quote or backslash (`$'\c\\'`).
// Read in the wrong place, a command bash runs after the string is taken for
// data. The shared reader now ends them where bash does when it reads words,
// substitutions and `$(...)` bodies (readAnsiC(), closeParen(), akmods
// 9d62f85), and a heredoc delimiter since akmods d790ec8 (`<<$'\''`,
// readHeredocStart()), but the body of an extended glob group
// (extglobAsStar()) still reads `$'` as a plain `'`. So a command line holding
// such a string is still refused. The body is matched the way bash's lexer
// reads it: a backslash and the character after it are one unit.
const MISREAD_ANSI_C = /\$'(?:[^'\\]|\\[^'c]|\\c[^'\\])*(?:\\'|\\c['\\])/;

/** Analyse a command line. Returns null if allowed, else { blocked, reason }. */
export function checkCommand(command, state = {}) {
    if (MISREAD_ANSI_C.test(command)) {
        return block(
            "Blocked: a `$'...'` string holding `\\'`, or `\\c` before a quote or backslash; this hook cannot tell " +
                'where bash ends it, so a command after it could go unchecked. Write the text with plain quotes instead.'
        );
    }
    // A directory change this hook cannot follow leaves the working directory
    // unknown for the whole command line. Substitutions are checked before the
    // segments around them, so this is decided first, as a fail-closed reading
    // that does not follow execution order.
    const segments = tokenize(command);
    if (segments.some(untrackedDirectoryChange)) state.cwd = null;
    for (const sub of extractSubstitutions(command)) {
        const r = checkCommand(sub, state);
        if (r) return r;
    }
    for (const words of segments) {
        const r = checkSegment(words, state);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function main(check = checkCommand, budgetMs = BUDGET_MS) {
    // Claude Code blocks only on exit 2; any other failure (an uncaught
    // exception exits 1) lets the command run. So nothing may escape this function.
    try {
        let payload;
        try {
            payload = JSON.parse(readFileSync(0, 'utf8'));
        } catch {
            process.stderr.write('guard-bash: could not parse hook input as JSON; blocking (fail closed).\n');
            process.exit(2);
        }
        if (payload?.tool_name && payload.tool_name !== 'Bash') process.exit(0);
        const command = payload?.tool_input?.command;
        if (typeof command !== 'string' || !command.trim()) process.exit(0);

        startBudget(budgetMs);
        const result = check(command, typeof payload?.cwd === 'string' ? { cwd: payload.cwd } : {});
        if (result) {
            process.stderr.write(`guard-bash: ${result.reason}\n`);
            process.exit(2);
        }
    } catch (err) {
        if (err instanceof OverBudget) {
            process.stderr.write(`guard-bash: ${err.message}\n${GUIDANCE}\n`);
            process.exit(2);
        }
        process.stderr.write(`guard-bash: internal error (${err?.message ?? err}); blocking (fail closed).\n`);
        process.exit(2);
    }
    process.exit(0);
}

/** True when this file is the program being run (also through a symlink); never fails open. */
function isMain() {
    const arg = process.argv[1];
    if (!arg) return false;
    const self = fileURLToPath(import.meta.url);
    if (resolve(arg) === self) return true;
    try {
        return realpathSync(arg) === self;
    } catch {
        // Cannot tell: assume we are the hook if the file is named like it.
        return basename(arg) === 'guard-bash.mjs';
    }
}

if (isMain()) main();
