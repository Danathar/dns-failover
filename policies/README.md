# Policies as code

JSON policies that `node scripts/check-policies.mjs` evaluates against the
repository tree. The `policy-check` workflow
([`.github/workflows/policy-check.yml`](../.github/workflows/policy-check.yml))
runs it on every pull request and push to `main`. Tests are in
[`scripts/tests/check-policies.test.mjs`](../scripts/tests/check-policies.test.mjs)
(`node --test scripts/tests/check-policies.test.mjs`); each policy has a test
that the real tree passes and tests that a mutated copy fails.

Changing a policy is a Tier 1 change in [docs/risk-tiers.md](../docs/risk-tiers.md)
and needs the owner. Why these policies exist, and what the script itself does
and does not defend against, is in
[docs/security/SECURITY-AI.md](../docs/security/SECURITY-AI.md).

## repo-target.json

Stops agent instructions from sending work to the wrong repository.

- Every file that exists and matches `directionGlobs` must contain the literal
  `--repo Danathar/dns-failover`. Globs for files that do not exist are
  ignored.
- In those files and in every `.md` under the repository root, `docs/`,
  `.github/`, `.claude/` and `policies/` (`scanGlobs`), each
  `gh pr|issue|release|workflow|label` write command (`create`, `comment`,
  `edit`, `close`, `reopen`, `merge`, `review`, `delete`, `run`, and the others
  in `writeCommandPattern`) and the `rerun`, `cancel` and `delete` verbs of
  `gh run` must carry `--repo Danathar/dns-failover`, or
  `-R Danathar/dns-failover`, on the same logical line (an environment variable
  is not enough in markdown). A command continued with a trailing backslash is
  one line. There is no exemption for prose: describe an unscoped command in
  words, or add the flag.
- No scanned line may pass `--repo`/`-R` for another repository to a `gh`
  write command, set `GH_REPO=` to another repository, or run
  `gh repo set-default` for another repository. Read-only links to other
  repositories are allowed.
- `excludeGlobs` is empty on purpose. Add an exemption only with a reason.

## workflow-permissions.json

For every `.github/workflows/*.yml`:

- a top-level `permissions:` block is present, so the token never gets the
  repository default, and it grants no write (`write-all` or `<scope>: write`
  is rejected; grant write on the job that needs it);
- `pull_request_target` is not used;
- every `uses:` outside `actions/` and `github/` is pinned to a 40-character
  commit SHA (keep the tag in a trailing `# vX` comment); local `./` and
  `docker://` references are skipped;
- every logical line that runs a `gh` write command passes `--repo`/`-R` with
  `Danathar/dns-failover` or `${{ github.repository }}`; or passes
  `"$GH_REPO"`, or nothing, when `env:` of that command's own step, its job or
  the workflow sets `GH_REPO` to one of those values. Scope follows the YAML
  block, so a `GH_REPO` in another job or step does not count. Any other
  `GH_REPO` or `--repo` value fails;
- a command-local `GH_REPO=<value>` before a `gh` write command (including
  `env GH_REPO=<value> gh ...`) must itself be an allowed value;
- `run:` scripts contain no attacker-controlled expression such as
  `${{ github.event.issue.title }}`, `github.head_ref` or `inputs.*`; pass it
  through `env:` and read `"$VAR"` (see `forbiddenRunExpressions`). Numbers,
  SHAs and `github.event.repository.name` are allowed.

## check-policies-corpus.json

Not a policy the checker reads: a regression table its tests replay. Six
repositories carry their own copy of `scripts/check-policies.mjs`, and a fix
to one copy does not reach the others
([Danathar/akmods#245](https://github.com/Danathar/akmods/issues/245)). Each
row is one workflow file (`workflow`, one string per line) and every
run-expression violation the checker must report for it (`violations`, each a
`line` and an `expression`; an empty list means the workflow must pass).
`scripts/tests/check-policies.test.mjs` writes each row to a scratch
`.github/workflows/` directory, runs `checkWorkflows` with this repository's
`workflow-permissions.json`, and requires exactly those violations.

This repository holds the canonical copy. A fix to any copy of the checker
adds a row here first, with the workflow the old code let through. The file is
then copied byte for byte to akmods, openaudible-autoupdate, tududi and
appbox, which pin its SHA-256 in their checker tests and compare their copy
with this one on `main` every night, so a copy that is behind fails.

## installer-safety.json

Guards `install-dns-failover.sh`, the root installer that replaces
`/etc/dnsmasq.conf`. Line-based, comment lines ignored, evaluated by
`checkFileRules`. A missing file is a violation, so the policy never passes
vacuously. The rules are `required` (a line must match), `forbidden` (none may),
`everyAfter` (every match comes after the first match of another pattern) and
`followedWithin` (every match has an expected line within N lines after it).

- `set -eu` is present and `set +e` is not, so a failing command aborts.
- `dnsmasq --test --conf-file="$config"` exists, is not followed by `|| true`,
  and every install of `"$config"` to `/etc/dnsmasq.conf` comes after it.
- `"$original"` is `dnsmasq.conf.before-failover` and `"$backup"` is
  `dnsmasq.conf.last-good`, both in `/var/lib/dns-failover-backups`, so the two
  can never be the same file.
- The running `/etc/dnsmasq.conf` is copied to `"$backup"` before the new config
  is installed, by an unindented command of its own, so the copy happens on
  every run. It uses `--remove-destination`, so it cannot write through a
  symlink saved by an earlier run.
- The copy to `"$original"` is the only line inside the
  `if [ ! -e "$original" ] && [ ! -L "$original" ]; then` guard, so the
  first-install original is never replaced, even as a dangling link.
- `systemd-helper checkconfig` runs after the install, inside the
  `if ! ... || ! systemctl restart dnsmasq.service; then` failure branch; the
  branch prints which config it restores, copies the backup back with
  `cp -a --remove-destination` so a symlink returns as a symlink, restarts
  dnsmasq and exits non-zero.
- The installer uses no `curl`, `wget` or `sudo`.

## credential-safety.json

- `tailscale-dns-failover/configure.py`: `auto_restore` is written as `False`;
  the config is created with `os.O_CREAT | os.O_EXCL` and mode `0o600` in a
  `0o700` directory; an existing config is refused; the secret is read with
  `getpass`; the secret is never printed; no mode grants group or other access.
- `tailscale-dns-failover/monitor.py`: `config.get('auto_restore', False)`; no
  default of true; the secret is never printed.
- `tailscale-dns-failover/tailscale-dns-failover.service`: `UMask=0077` and
  `StateDirectoryMode=0700`.
- `secretScan` over every text file (binary and files over 1 MB are skipped,
  and so is this policy file, which holds the patterns): no Tailscale key
  (`tskey-...`), GitHub token, LLM API key, AWS key ID, private-key block or
  `client_secret` value in JSON; no ControlD profile ID in
  `<id>.dns.controld.com` or `dns.controld.com/<id>` unless it is one of
  `allowedProfileIds` (placeholders). A hit is reported by file, line and kind,
  never by value. Build fake secrets in tests at run time (concatenation) so the
  test file itself stays clean.

## temp-path-safety.json

- Every text file (binary and files over 1 MB are skipped) is scanned line by
  line for a fixed-name path directly under one of the three shared temporary
  directories (`/tmp`, `/var/tmp`, `/dev/shm`): the `pattern`, one of those
  folders followed by one name. The name may be wrapped in quotes, follow a
  doubled slash, or start with `$` or `${` (a default-value form such as a `TMPDIR` fallback
  to the folder is caught too), because the shell resolves all of these
  to the same fixed path. A match counts only when it starts an absolute path,
  so a `tmp` folder under `/run/user/1000`, and URL paths, are not hits, while
  the same path after `=`, after `-I` or inside backticks is.
- Known limit: a bare directory followed by a relative name is not seen by a
  line pattern, and widening it would flag the safe `/tmp` and `/tmp/`.
  Examples are `cd /tmp && cp x name`, `WorkingDirectory=/tmp` and
  `ReadWritePaths=/tmp`. Review has to catch these.
- `excludeGlobs` (files that are not shipped): `tests/**`, `**/tests/**`,
  `**/fixtures/**`, `.claude/**`, and the policy file itself, whose `allowed`
  list names the paths.
- `allowed` lists `{ "path", "tmpPath", "why" }` exceptions. A hit passes only
  when both its file and its exact path are listed, so a new name in a listed
  file still fails. An entry that matches no line is a violation, so the list
  cannot go stale. It starts empty.
- The message names file, line and path and points to the safe alternatives:
  `RuntimeDirectory=` or `StateDirectory=`, `PrivateTmp=yes`, `mktemp -d`, or a
  root-owned directory under `/run` created with `install -d -m 0700`.
- Why: another account can create a fixed-name folder first and then control
  what a root-run command reads from it.

## CODEOWNERS and risk tiers

Not JSON policy files. The checker compares the tier table in
[docs/risk-tiers.md](../docs/risk-tiers.md) with
[`risk-config.json`](../risk-config.json) and fails when tier numbers, names,
paths, required commands or review values differ (a literal `|` in a command is
written `\|` in the table). It also fails when a path in a tier whose review is
`owner` has no entry for `owner` in [`.github/CODEOWNERS`](../.github/CODEOWNERS),
or when CODEOWNERS has a catch-all `*` entry. `**/x` in the config is `x` in
CODEOWNERS, `dir/**` is `/dir/`, anything else is `/path`.
`node scripts/check-policies.mjs --classify <path>...` prints the tier of a
path. It cannot see inside a file, so it does not apply the "Raise the tier"
rules.

## Threat model

The checker catches accidental omissions: an agent-direction file or workflow
that forgets `--repo Danathar/dns-failover`, a missing `permissions:` block, an
unpinned action, an event expression interpolated into a script, an installer
refactor that installs the config before `dnsmasq --test` or drops the restore,
a default flipped to `auto_restore` true, a committed token or profile ID. It
is not a shell, Python or YAML parser and does not defend against deliberately
obfuscated commands (variables built at runtime, `eval`, generated scripts,
aliases, a secret split across strings). The hard boundaries are the
repository-scoped `GITHUB_TOKEN`, the required status checks and the owner's
merge. CODEOWNERS only requests the owner's review unless the ruleset requires
it.
