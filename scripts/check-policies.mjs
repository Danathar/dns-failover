#!/usr/bin/env node
/**
 * Policy-as-code checker. Evaluates the JSON policies in policies/ and the
 * risk-tier table against the files in a repository tree.
 *
 *   node scripts/check-policies.mjs                 check this repository
 *   node scripts/check-policies.mjs --root <dir>    check another tree (tests)
 *   node scripts/check-policies.mjs --classify <path>...
 *                                                   print the risk tier of paths
 *
 * Checks:
 *   1. policies/repo-target.json        gh write commands name this repository
 *   2. policies/workflow-permissions.json  workflow token scope and pinning
 *   3. policies/installer-safety.json   install-dns-failover.sh validates and restores dnsmasq.conf
 *   4. policies/credential-safety.json  root-only credentials, auto_restore off, no secrets or profile IDs
 *   5. docs/risk-tiers.md vs risk-config.json  tier table drift
 *   6. .github/CODEOWNERS vs risk-config.json  owner-review paths are listed
 *
 * Node built-ins only. Exit code 1 when any violation is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

// ---------------------------------------------------------------- helpers

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function matchesAny(globs, file) {
    return globs.some((g) => globToRegExp(g).test(file));
}

/** All files under root as posix relative paths. */
export function walk(root, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, rel), {
        withFileTypes: true,
    })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, r));
        } else if (entry.isFile()) {
            out.push(r);
        }
    }
    return out.sort();
}

function readJson(root, rel, violations) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        violations.push(`${rel}: missing`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        violations.push(`${rel}: invalid JSON (${err.message})`);
        return null;
    }
}

// --------------------------------------------------- 1. repo-target policy

/**
 * Split text into logical lines, joining shell continuations (trailing
 * backslash) so a multi-line `gh` command is judged as one command.
 * Returns [{ line, text }] where line is the 1-based first physical line.
 */
export function logicalLines(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let joined = lines[i];
        const start = i + 1;
        while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
            joined = joined.replace(/\\\s*$/, ' ') + lines[++i].trim();
        }
        out.push({ line: start, text: joined });
    }
    return out;
}

/**
 * Find `gh <noun> <verb>` write commands in a logical line. There is no
 * exemption for prose: a line that spells a write command without the repo
 * flag is a violation even when it describes the mistake. Reword it.
 */
export function findWriteCommands(text, writeRe) {
    return [...text.matchAll(new RegExp(writeRe, 'g'))].map((m) => m[0]);
}

export function checkRepoTarget(root, policy, files) {
    const v = [];
    const literal = policy.requiredLiteral;
    const repoRe = new RegExp(policy.repoFlagPattern);
    const forbidden = policy.forbiddenPatterns.map((p) => new RegExp(p));

    const directionFiles = files.filter((f) =>
        matchesAny(policy.directionGlobs, f),
    );
    for (const f of directionFiles) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        if (!text.includes(literal)) {
            v.push(
                `${f}: agent-directions file must contain the literal "${literal}" ` +
                    `(PRs and issues go to this repository only)`,
            );
        }
    }

    const scanned = new Set([
        ...files.filter((f) => matchesAny(policy.scanGlobs, f)),
        ...directionFiles,
    ]);
    for (const f of [...scanned].sort()) {
        if (matchesAny(policy.excludeGlobs ?? [], f)) continue;
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        for (const { line, text: t } of logicalLines(text)) {
            for (const re of forbidden) {
                if (re.test(t)) {
                    v.push(
                        `${f}:${line}: names another repository for a write ` +
                            `(${re.source}); work stays in Danathar/dns-failover`,
                    );
                }
            }
            // Judge each write command on its own segment, so one --repo does
            // not cover every command on the line.
            const starts = [...t.matchAll(new RegExp(policy.writeCommandPattern, 'g'))].map((m) => m.index);
            starts.forEach((from, n) => {
                const seg = t.slice(from, starts[n + 1] ?? t.length);
                if (!repoRe.test(seg)) {
                    const cmd = seg.match(new RegExp(policy.writeCommandPattern))[0];
                    v.push(
                        `${f}:${line}: "${cmd}" without ${literal} ` +
                            `(a bare gh command targets whatever repository the clone defaults to)`,
                    );
                }
            });
        }
    }
    return v;
}

// ------------------------------------------- file-invariant rules and secrets

/** Replace full-line `#` comments (shell, Python, YAML, systemd) with blanks. */
const stripComments = (lines) => lines.map((l) => (/^\s*#/.test(l) ? '' : l));

/**
 * Line-based invariants for the files named in a policy's `files` array.
 * Comment lines are ignored. Each file may carry:
 *   required        a line must match `pattern`
 *   forbidden       no line may match `pattern`
 *   everyAfter      every line matching `pattern` comes after the first line
 *                   matching `after`; both must exist, so it never passes
 *                   vacuously
 *   followedWithin  every line matching `pattern` has a line matching
 *                   `expect` in the next `within` lines; `pattern` must exist
 * A missing file is a violation. These checks prove a guard is present and
 * ordered; they do not parse the language and do not prove the guard correct.
 */
export function checkFileRules(root, policy, policyName) {
    const v = [];
    for (const spec of policy.files) {
        const rel = spec.path;
        const file = path.join(root, rel);
        if (!fs.existsSync(file)) {
            v.push(`${rel}: missing (${policyName} policy cannot be checked)`);
            continue;
        }
        const code = stripComments(fs.readFileSync(file, 'utf8').split(/\r?\n/));
        const hits = (re) => code.flatMap((l, i) => (re.test(l) ? [i] : []));
        for (const r of spec.required ?? []) {
            if (hits(new RegExp(r.pattern)).length === 0) {
                v.push(`${rel}: ${r.why} (no line matches /${r.pattern}/)`);
            }
        }
        for (const r of spec.forbidden ?? []) {
            for (const i of hits(new RegExp(r.pattern))) {
                v.push(`${rel}:${i + 1}: ${r.why}`);
            }
        }
        for (const r of spec.everyAfter ?? []) {
            const anchor = hits(new RegExp(r.after))[0];
            const targets = hits(new RegExp(r.pattern));
            if (anchor === undefined) {
                v.push(`${rel}: ${r.why} (no line matches /${r.after}/)`);
            }
            if (targets.length === 0) {
                v.push(`${rel}: ${r.why} (no line matches /${r.pattern}/)`);
            }
            for (const i of targets) {
                if (anchor !== undefined && i <= anchor) {
                    v.push(`${rel}:${i + 1}: ${r.why}`);
                }
            }
        }
        for (const r of spec.followedWithin ?? []) {
            const targets = hits(new RegExp(r.pattern));
            if (targets.length === 0) {
                v.push(`${rel}: ${r.why} (no line matches /${r.pattern}/)`);
            }
            const expect = new RegExp(r.expect);
            for (const i of targets) {
                if (!code.slice(i + 1, i + 1 + r.within).some((l) => expect.test(l))) {
                    v.push(`${rel}:${i + 1}: ${r.why}`);
                }
            }
        }
    }
    return v;
}

/**
 * Credential-shaped strings and ControlD profile IDs must not be committed.
 * Reports file, line and the kind of match, never the matched text, so a
 * leaked value is not copied into CI logs.
 */
export function checkSecretScan(root, scan, files) {
    const v = [];
    const tokens = scan.tokenPatterns.map((t) => ({ name: t.name, re: new RegExp(t.pattern) }));
    const profiles = scan.profileIdPatterns.map((p) => new RegExp(p, 'g'));
    const allowed = new Set(scan.allowedProfileIds.map((s) => s.toLowerCase()));
    for (const f of files) {
        if (matchesAny(scan.excludeGlobs ?? [], f)) continue;
        const buf = fs.readFileSync(path.join(root, f));
        if (buf.length > 1_000_000 || buf.includes(0)) continue;
        buf.toString('utf8').split(/\r?\n/).forEach((l, i) => {
            for (const t of tokens) {
                if (t.re.test(l)) v.push(`${f}:${i + 1}: credential-shaped string (${t.name}); never commit secrets`);
            }
            for (const re of profiles) {
                for (const m of l.matchAll(re)) {
                    if (!allowed.has(m[1].toLowerCase())) {
                        v.push(`${f}:${i + 1}: ControlD profile ID that is not a placeholder; site-specific values stay out of the repository`);
                    }
                }
            }
        });
    }
    return v;
}

// ------------------------------------------------------------- CODEOWNERS

/** The CODEOWNERS pattern a risk-config glob should appear as. */
export function codeownersPattern(glob) {
    let p = glob;
    let anywhere = false;
    if (p.startsWith('**/')) {
        p = p.slice(3);
        anywhere = true;
    }
    if (p.endsWith('/**')) p = p.slice(0, -2);
    return anywhere ? p : `/${p}`;
}

/**
 * A CODEOWNERS pattern as an anchored RegExp over posix paths, following
 * GitHub's gitignore-style rules: a leading or inner `/` anchors the pattern
 * to the repository root, otherwise it matches at any depth; a trailing `/`
 * matches only what is under that directory; a pattern that names a directory
 * without the trailing `/` covers everything under it as well.
 */
export function codeownersRegExp(pattern) {
    let p = pattern;
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.includes('/');
    if (p.startsWith('/')) p = p.slice(1);
    const body = globToRegExp(p).source.slice(1, -1);
    const prefix = anchored ? '' : '(?:.*/)?';
    return new RegExp(`^${prefix}${body}${dirOnly ? '/.*' : '(?:/.*)?'}$`);
}

/**
 * Every path of a tier whose review is `owner` must be listed in CODEOWNERS
 * with the owner, so the required review cannot drift from docs/risk-tiers.md.
 * There must be no `*` entry: the ruleset requires code owner review, so a
 * catch-all would make every pull request, Tier 3 included, wait for the owner.
 *
 * GitHub applies the last entry that matches a file, so an entry being present
 * is not enough: a later line such as `*.py` with no owner would take the
 * owner's review off every Tier 1 script while every entry above is intact.
 * Each of `files` that classifies into an owner-review tier must therefore be
 * owned by `owner` under its last matching entry.
 */
export function checkCodeowners(config, text, owner, files = []) {
    const v = [];
    const entries = new Map();
    const ordered = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+#.*$/, '').trim();
        if (!line || line.startsWith('#')) continue;
        const [pat, ...owners] = line.split(/\s+/);
        entries.set(pat, owners);
        ordered.push({ pat, owners, re: codeownersRegExp(pat) });
    }
    if (entries.has('*')) {
        v.push('.github/CODEOWNERS: no "*" entry; code owner review is required, so it would cover every pull request');
    }
    for (const t of config.tiers) {
        if (t.review !== 'owner') continue;
        for (const g of t.paths) {
            const want = codeownersPattern(g);
            if (!(entries.get(want) ?? []).includes(owner)) {
                v.push(`.github/CODEOWNERS: tier ${t.tier} path "${g}" needs an entry "${want} ${owner}"`);
            }
        }
    }
    for (const f of files) {
        const t = classify(config, f);
        if (t.review !== 'owner') continue;
        const last = ordered.findLast((e) => e.re.test(f));
        if (!last) {
            v.push(`.github/CODEOWNERS: tier ${t.tier} file "${f}" matches no entry, so it needs no review`);
        } else if (!last.owners.includes(owner)) {
            const who = last.owners.length ? last.owners.join(' ') : 'no owner';
            v.push(`.github/CODEOWNERS: tier ${t.tier} file "${f}" ends up with ${who}: GitHub applies its last matching entry, "${last.pat}"`);
        }
    }
    return v;
}

// ---------------------------------------------- 2. workflow-permissions policy

const indentOf = (l) => l.match(/^\s*/)[0].length;
const isBlank = (l) => l.trim() === '';

/** Index of the nearest earlier non-blank line with smaller indent, or -1. */
function parentOf(code, i, indent = indentOf(code[i])) {
    for (let j = i - 1; j >= 0; j--) {
        if (!isBlank(code[j]) && indentOf(code[j]) < indent) return j;
    }
    return -1;
}

/**
 * Top-level `permissions:` must exist and must not grant write access
 * (`write-all` or any `<scope>: write`); wider scopes belong on a job.
 */
export function checkTopLevelPermissions(f, code, policy) {
    const at = code.findIndex((l) => /^permissions\s*:/.test(l));
    if (at === -1) {
        return [
            `${f}: no top-level "permissions:" (the token would get the repository default)`,
        ];
    }
    const v = [];
    const inline = code[at].replace(/^permissions\s*:/, '').trim();
    if (inline === 'write-all') {
        v.push(`${f}:${at + 1}: top-level permissions: write-all`);
    }
    if (policy.forbidTopLevelWrite !== false) {
        for (let j = at + 1; j < code.length; j++) {
            if (isBlank(code[j])) continue;
            if (indentOf(code[j]) === 0) break;
            if (/:\s*write\b/.test(code[j])) {
                v.push(
                    `${f}:${j + 1}: top-level permissions grant write ("${code[j].trim()}"); grant it on the job that needs it`,
                );
            }
        }
        if (/\bwrite\b/.test(inline) && inline !== 'write-all') {
            v.push(`${f}:${at + 1}: top-level permissions grant write`);
        }
    }
    return v;
}

/**
 * GH_REPO values valid for the block that starts at line `a`: a direct
 * `env:` child of that block (workflow, job or step) that sets GH_REPO.
 */
function blockGhRepo(code, a) {
    // a === -1 is the workflow root: its children sit at indent 0.
    const indent = a === -1 ? -1 : indentOf(code[a]);
    const dash = a !== -1 && /^\s*-\s/.test(code[a]);
    let childIndent = a === -1 ? 0 : dash ? indent + 2 : -1;
    let end = code.length;
    for (let j = a + 1; j < code.length; j++) {
        if (isBlank(code[j])) continue;
        if (indentOf(code[j]) <= indent) {
            end = j;
            break;
        }
        if (childIndent === -1) childIndent = indentOf(code[j]);
    }
    const found = [];
    for (let j = a + 1; j < end; j++) {
        const m = code[j].match(/^\s*GH_REPO\s*:\s*(.+?)\s*$/);
        if (!m) continue;
        const envLine = parentOf(code, j);
        if (
            envLine !== -1 &&
            /^\s*env\s*:\s*$/.test(code[envLine]) &&
            indentOf(code[envLine]) === childIndent
        ) {
            found.push({ line: j, value: m[1] });
        }
    }
    return found;
}

/**
 * Every `gh` write command must name this repository: `--repo`/`-R` with an allowed
 * literal, or with `$GH_REPO` when the command's own step, its job or the
 * workflow sets GH_REPO to an allowed value in `env:`; or no flag at all when
 * such a GH_REPO is in scope. Scope is by YAML block, so a GH_REPO in another
 * job or step does not count. Any GH_REPO or --repo naming another repository
 * is a violation.
 */
// Value of --repo/-R: a GH_REPO reference, the github.repository expression,
// or an owner/repo token that stops at the first character that cannot be in
// one (quotes, ':', ')', ',', whitespace), so `--repo Danathar/dns-failover:*),` in
// an --allowedTools string reads as Danathar/dns-failover.
const REPO_FLAG =
    /(?:--repo|-R)(?:\s+|=)["']?(\$\{?GH_REPO\}?|\$\{\{\s*github\.repository\s*\}\}|[\w.-]+\/[\w.-]+|[^\s"',:)]+)/;

export function checkGhScope(f, code, policy) {
    const v = [];
    const allowed = policy.allowedRepoValues;
    const unq = (x) => x.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    const okLiteral = (x) => allowed.includes(unq(x));
    const reportedBad = new Set();
    code.forEach((l, i) => {
        const m = l.match(/^\s*GH_REPO\s*:\s*(.+?)\s*$/);
        if (m && !okLiteral(m[1])) {
            v.push(`${f}:${i + 1}: GH_REPO is "${m[1]}", expected ${allowed[0]} or Danathar/dns-failover`);
            reportedBad.add(i);
        }
    });
    const logical = logicalLines(code.join('\n'));
    for (const { line, text: t } of logical) {
        const writes = findWriteCommands(t, policy.ghWriteCommandPattern);
        if (writes.length === 0) continue;
        // Blocks enclosing the command: its own line, then its ancestors.
        const chain = [];
        let at = line - 1;
        chain.push(at);
        while ((at = parentOf(code, at)) !== -1) chain.push(at);
        // A step that starts with "- run:" is its own block; a "run: |" body
        // sits under the step's "- name:" ancestor, found by parentOf above.
        const okEnv = (g) => okLiteral(g.value) && !reportedBad.has(g.line);
        const scoped =
            chain.some((a) => blockGhRepo(code, a).some(okEnv)) ||
            blockGhRepo(code, -1).some(okEnv);
        // Judge each write command on its own segment of the line, so a
        // line that lists several (an --allowedTools string) is not
        // misread as one command with one flag.
        const starts = [
            ...t.matchAll(new RegExp(policy.ghWriteCommandPattern, 'g')),
        ].map((m) => m.index);
        starts.forEach((from, n) => {
            const seg = t.slice(from, starts[n + 1] ?? t.length);
            const cmd = seg.match(new RegExp(policy.ghWriteCommandPattern))[0];
            // A command-local GH_REPO (`GH_REPO=x gh ...`, `env GH_REPO=x gh ...`)
            // overrides the scoped env: value, so it must be valid itself.
            const prefix = t.slice(0, from).split(/;|&&|\|\||\||\(|`/).pop();
            const local = prefix.match(/\bGH_REPO=(\S+)/);
            if (local && !okLiteral(local[1])) {
                v.push(
                    `${f}:${line}: "${cmd}" is preceded by GH_REPO=${local[1]}, expected ${allowed[0]} or Danathar/dns-failover`,
                );
                return;
            }
            const flag = seg.match(REPO_FLAG);
            if (flag) {
                const val = flag[1];
                const viaEnv = /^\$\{?GH_REPO\}?$/.test(val);
                if (viaEnv ? !scoped : !okLiteral(val)) {
                    v.push(
                        viaEnv
                            ? `${f}:${line}: "${cmd}" uses $GH_REPO but no valid GH_REPO is set in this step, job or workflow env`
                            : `${f}:${line}: "${cmd}" targets "${val}", expected ${allowed[0]} or Danathar/dns-failover`,
                    );
                }
            } else if (!scoped && !local) {
                v.push(
                    `${f}:${line}: "${cmd}" has no --repo and no valid GH_REPO is set in this step, job or workflow env`,
                );
            }
        });
    }
    return v;
}

/** Reject attacker-controlled event expressions inside `run:` scripts. */
export function checkRunExpressions(f, code, policy) {
    const v = [];
    // Contexts are case-insensitive and `a['b']` equals `a.b`.
    const bad = new RegExp(policy.forbiddenRunExpressions, 'i');
    for (let i = 0; i < code.length; i++) {
        const m = code[i].match(/^(\s*(?:-\s+)?)run\s*:\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const body = [m[2]];
        for (let j = i + 1; j < code.length; j++) {
            if (!isBlank(code[j]) && indentOf(code[j]) <= indent) break;
            body.push(code[j]);
        }
        body.forEach((b, k) => {
            for (const e of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
                const norm = e[1].replace(/\[\s*(['"])(.*?)\1\s*\]/g, '.$2');
                if (bad.test(norm)) {
                    v.push(
                        `${f}:${i + 1 + k}: \${{${e[1]}}} in a run script; pass it through env: and use "$VAR"`,
                    );
                }
            }
        });
    }
    return v;
}

export function checkWorkflows(root, policy, files) {
    const v = [];
    const pin = new RegExp(policy.pinPattern);
    const trusted = new Set(policy.trustedActionOwners);
    const writeRe = policy.ghWriteCommandPattern;
    const workflows = files.filter((f) => matchesAny(policy.workflowGlobs, f));

    for (const f of workflows) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        const lines = text.split(/\r?\n/);
        const code = lines.map((l) => l.replace(/(^|\s)#.*$/, ''));

        if (policy.requireTopLevelPermissions) {
            v.push(...checkTopLevelPermissions(f, code, policy));
        }

        code.forEach((l, i) => {
            for (const trigger of policy.forbiddenTriggers) {
                if (new RegExp(`\\b${trigger}\\b`).test(l)) {
                    v.push(`${f}:${i + 1}: forbidden trigger ${trigger}`);
                }
            }
            const m = l.match(/\buses\s*:\s*['"]?([^\s'"]+)/);
            if (!m) return;
            const ref = m[1];
            if (ref.startsWith('./') || ref.startsWith('docker://')) return;
            const [name, version = ''] = ref.split('@');
            const owner = name.split('/')[0];
            if (trusted.has(owner)) return;
            if (!pin.test(version)) {
                v.push(
                    `${f}:${i + 1}: third-party action ${name} must be pinned to a full commit SHA (found "${version || 'no ref'}")`,
                );
            }
        });

        if (policy.ghWriteNeedsRepo) v.push(...checkGhScope(f, code, policy));
        if (policy.forbiddenRunExpressions) {
            v.push(...checkRunExpressions(f, lines, policy));
        }
    }
    return v;
}

// ------------------------------------------------------ 3. risk-tier drift

export function classify(config, file) {
    let best = null;
    for (const t of config.tiers) {
        if (matchesAny(t.paths, file) && (best === null || t.tier < best.tier)) {
            best = t;
        }
    }
    return best ?? config.tiers.find((t) => t.tier === config.default_tier);
}

const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export function parseTierTable(markdown) {
    const rows = [];
    for (const raw of markdown.split(/\r?\n/)) {
        if (!/^\|\s*\d+\s*\|/.test(raw)) continue;
        const cells = raw.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        if (cells.length !== 5) {
            rows.push({ malformed: raw });
            continue;
        }
        rows.push({
            tier: Number(cells[0]),
            name: cells[1],
            paths: ticks(cells[2]),
            commands: ticks(cells[3]),
            review: ticks(cells[4])[0] ?? cells[4],
        });
    }
    return rows;
}

const diff = (a, b) => a.filter((x) => !b.includes(x));

export function checkRiskTiers(config, markdown) {
    const v = [];
    const doc = 'docs/risk-tiers.md';
    const json = 'risk-config.json';
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
        return [`${json}: "tiers" must be a non-empty array`];
    }
    const nums = config.tiers.map((t) => t.tier);
    if (new Set(nums).size !== nums.length) {
        v.push(`${json}: duplicate tier numbers`);
    }
    if (!nums.includes(config.default_tier)) {
        v.push(`${json}: default_tier ${config.default_tier} is not a defined tier`);
    }
    const rows = parseTierTable(markdown);
    for (const r of rows.filter((r) => r.malformed)) {
        v.push(`${doc}: malformed tier row "${r.malformed}" (need 5 columns)`);
    }
    const docRows = rows.filter((r) => !r.malformed);
    for (const t of config.tiers) {
        const row = docRows.find((r) => r.tier === t.tier);
        if (!row) {
            v.push(`${doc}: tier ${t.tier} (${t.name}) is in ${json} but not in the table`);
            continue;
        }
        if (row.name !== t.name) {
            v.push(`${doc}: tier ${t.tier} is named "${row.name}", ${json} says "${t.name}"`);
        }
        const sets = [
            ['paths', row.paths, t.paths],
            ['required commands', row.commands, t.required_commands],
        ];
        for (const [label, d, j] of sets) {
            for (const x of diff(j, d)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in ${json} but not in the table`);
            }
            for (const x of diff(d, j)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in the table but not in ${json}`);
            }
        }
        if (row.review !== t.review) {
            v.push(`${doc}: tier ${t.tier} review is "${row.review}", ${json} says "${t.review}"`);
        }
    }
    for (const r of docRows) {
        if (!nums.includes(r.tier)) {
            v.push(`${doc}: tier ${r.tier} is in the table but not in ${json}`);
        }
    }
    return v;
}

// ------------------------------------------------------------------- main

export function checkAll(root) {
    const violations = [];
    const files = walk(root);

    const target = readJson(root, 'policies/repo-target.json', violations);
    if (target) violations.push(...checkRepoTarget(root, target, files));

    const wf = readJson(root, 'policies/workflow-permissions.json', violations);
    if (wf) violations.push(...checkWorkflows(root, wf, files));

    const installer = readJson(root, 'policies/installer-safety.json', violations);
    if (installer) violations.push(...checkFileRules(root, installer, 'installer-safety'));

    const cred = readJson(root, 'policies/credential-safety.json', violations);
    if (cred) {
        violations.push(...checkFileRules(root, cred, 'credential-safety'));
        violations.push(...checkSecretScan(root, cred.secretScan, files));
    }

    const config = readJson(root, 'risk-config.json', violations);
    const docPath = path.join(root, 'docs/risk-tiers.md');
    if (!fs.existsSync(docPath)) {
        violations.push('docs/risk-tiers.md: missing');
    } else if (config) {
        violations.push(
            ...checkRiskTiers(config, fs.readFileSync(docPath, 'utf8')),
        );
    }
    const coPath = path.join(root, '.github/CODEOWNERS');
    if (!fs.existsSync(coPath)) {
        violations.push('.github/CODEOWNERS: missing');
    } else if (config && Array.isArray(config.tiers)) {
        if (typeof config.owner !== 'string' || !config.owner.startsWith('@')) {
            violations.push('risk-config.json: "owner" must be a GitHub handle such as "@Danathar"');
        } else {
            violations.push(
                ...checkCodeowners(config, fs.readFileSync(coPath, 'utf8'), config.owner, files),
            );
        }
    }
    return violations;
}

function main(argv) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let root = path.resolve(here, '..');
    const rootIdx = argv.indexOf('--root');
    if (rootIdx !== -1) root = path.resolve(argv[rootIdx + 1]);

    const classifyIdx = argv.indexOf('--classify');
    if (classifyIdx !== -1) {
        const config = JSON.parse(
            fs.readFileSync(path.join(root, 'risk-config.json'), 'utf8'),
        );
        for (const p of argv.slice(classifyIdx + 1)) {
            const t = classify(config, p.replace(/^\.\//, ''));
            console.log(`${p}: tier ${t.tier} (${t.name}), review: ${t.review}`);
        }
        return 0;
    }

    const violations = checkAll(root);
    if (violations.length > 0) {
        console.error(`check-policies: ${violations.length} violation(s)`);
        for (const x of violations) console.error(`  ${x}`);
        return 1;
    }
    console.log('check-policies: all policies satisfied');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
