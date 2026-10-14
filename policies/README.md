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
- The original `/etc/dnsmasq.conf` is copied to `"$backup"` before the new
  config is installed.
- `systemd-helper checkconfig` runs after the install, inside the
  `if ! ... || ! systemctl restart dnsmasq.service; then` failure branch; the
  branch installs the backup, restarts dnsmasq and exits non-zero.
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
