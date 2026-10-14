# Change risk tiers

How to classify a change to this repository, and what each tier requires before
it merges. Reviewers and agents use it. [Agent boundaries](agent-boundaries.md)
maps the tiers to what an agent may change without the owner.

The tier is set by **what the change can break**, not by diff size. This
repository is root-run Python and POSIX shell that rewrites `/etc/dnsmasq.conf`,
sends SIGHUP to dnsmasq every few seconds and, through the Tailscale API,
changes DNS settings for a whole tailnet. A one-line change to the failover
decision or to the installer's config check is Tier 1, and a 300-line change
to the README is Tier 3.

This file is the source. [`risk-config.json`](../risk-config.json) restates the
table below as data, and `node scripts/check-policies.mjs` fails when the two
disagree. To change a tier, edit both in the same pull request, and keep
[`.github/CODEOWNERS`](../.github/CODEOWNERS) in step: the checker also fails
when a path whose review is `owner` has no CODEOWNERS entry.

## Tier table

Tier 1 is the most dangerous. `**` matches any depth (`**/` also matches the
repository root), `*` matches within one directory level.

| Tier | Name | Covers | Required commands | Review |
| ---- | ---- | ------ | ----------------- | ------ |
| 1 | critical | `.github/workflows/**`, `.github/CODEOWNERS`, `.github/rulesets/**`, `.claude/settings.json`, `.claude/hooks/**`, `policies/**`, `scripts/check-policies.mjs`, `risk-config.json`, `renovate.json`, `LICENSE`, `AGENTS.md`, `install-dns-failover.sh`, `tailscale-dns-failover/install.sh`, `tailscale-dns-failover/configure.py`, `tailscale-dns-failover/monitor.py`, `dns-upstream-check.py` | `python3 -m pytest`, `ruff check .`, `git ls-files '*.sh' \| xargs shellcheck`, `tests/e2e/run.sh`, `python3 -m coverage run -m pytest && python3 -m coverage report`, `node scripts/check-policies.mjs`, `node --test 'scripts/tests/*.test.mjs'`, `node --test '.claude/hooks/tests/*.test.mjs'` | `owner` |
| 2 | high | `dns-upstream-probe.py`, `**/*.service`, `**/*.timer`, `**/dnsmasq-*.conf`, `**/*.conf.example`, `**/stubby-*.yml`, `**/stubby-*.yml.example`, `pyproject.toml`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/**`, `.github/prompts/**`, `.claude/skills/**`, `.claude/memory/**`, `.claude/session-summary.md`, `docs/risk-tiers.md`, `docs/agent-boundaries.md`, `docs/security/**` | `python3 -m pytest`, `ruff check .`, `git ls-files '*.sh' \| xargs shellcheck`, `node scripts/check-policies.mjs` | `owner` |
| 3 | standard | `tests/**`, `scripts/**`, `docs/**`, `*.md`, `.github/ISSUE_TEMPLATE/**`, `.github/pull_request_template.md`, `.github/labeler.yml`, `.github/auto-qa-tuning.json`, `.editorconfig`, `.shellcheckrc`, `.gitignore` | `python3 -m pytest`, `ruff check .`, `node --test 'scripts/tests/*.test.mjs'` | `ci` |

Review values: `owner` means the repository owner (Danathar) reads the diff and
merges it, and a green CI run alone is not enough. `ci` means the required CI
checks must pass: the four jobs in `.github/workflows/ci.yml` (`Lint`,
`Unit tests (debian 12)`, `Unit tests (debian 13)`, `E2E (debian container)`),
`Coverage gate`, `policy-check` and `agent-tooling`, and an agent may open and,
under the Hive merge strategy, queue the pull request.

## Raise the tier

A path glob cannot see inside a file, so some changes are riskier than the
table says. **Raise a change to Tier 1** when it:

- changes what a Tier 2 unit or drop-in runs, as which user, or when
  (`ExecStart=`, `User=`, `ConditionPathExists=`, timer cadence), because the
  units are what run the Tier 1 scripts as root;
- changes an example config in a way a user will copy: `listen-address` or
  Stubby `listen_addresses` beyond loopback (an open resolver), turning off TLS
  authentication, or moving the primary or backup ports the checker polls;
- edits `pyproject.toml` to lower the coverage floor, drop a lint rule or
  exclude product code from either;
- changes a command in the README or a doc that users run as root (the
  installers, `configure.py`);
- stubs out, skips or weakens a test of the failover decision, the
  `dnsmasq --test` and restore path, the PID-file check against
  `/proc/<pid>/comm`, or the `auto_restore` default.

A pull request that spans tiers meets the requirements of its highest tier.

## What the code guards

These are the invariants a Tier 1 change must keep. `node scripts/check-policies.mjs`
checks the minimum of them mechanically (the policies named below); everything
else is the reviewer's judgment, so a Tier 1 change states in the PR what was
checked.

- **Installer.** `install-dns-failover.sh` checks the reviewed config with
  `dnsmasq --test` before installing it, backs up the original
  `/etc/dnsmasq.conf` first, and restores the backup and exits non-zero when
  `checkconfig` or the restart fails ([`policies/installer-safety.json`](../policies/installer-safety.json)).
- **Credentials.** `configure.py` creates the config exclusively with mode
  0600 in a 0700 directory, never prints the secret, and writes `auto_restore`
  false; `monitor.py` treats a missing `auto_restore` as false
  ([`policies/credential-safety.json`](../policies/credential-safety.json)).
- **Site-specific data.** No credential-shaped string and no real ControlD
  profile ID anywhere in the repository (same policy).
- **Failover decision.** `dns-upstream-check.py` switches to the backup after
  one failed primary check only when the backup answers, returns after three
  healthy primary checks, keeps the selection when both fail, writes its files
  atomically and signals only a PID whose `/proc/<pid>/comm` is dnsmasq. The
  unit tests in `tests/unit` cover this; the reviewer confirms they still do.
- **Tailnet writes.** `monitor.py` turns the tailnet-wide DNS override off only
  after repeated ControlD failures while the local backup answers, and checks
  that the global nameservers still match the monitored profile before it
  sends an update.

## How to apply it

1. List every path the change touches.
2. Take the **highest-risk** (lowest-numbered) tier any path matches. A path
   that matches several rows, such as `docs/security/SECURITY-AI.md` (Tier 2)
   and `docs/**` (Tier 3), takes the lowest number.
3. A path no row lists is Tier 3.
4. Raise the tier, never lower it, using the rules above.
5. Run every command in the tier's Required column. `tests/e2e/run.sh` needs a
   container runtime (podman or docker); if you have none, say so in the PR and
   rely on the `E2E (debian container)` job. The commands exercise code only
   through fakes, temp directories and a throwaway container; see the host rule
   in [AI security policy](security/SECURITY-AI.md).

`node scripts/check-policies.mjs --classify <path> ...` prints the tier the
path table assigns to each path. It does not apply the rules in "Raise the
tier".

## Why these paths

- **`.github/workflows/**`, `.github/rulesets/**`, `.github/CODEOWNERS`.** What
  runs with repository tokens, what blocks a merge, and who must approve. A
  workflow that gets write scope or an interpolated issue title is a way into
  the repository.
- **`.claude/settings.json`, `.claude/hooks/**`.** The agent permission table and
  the Bash guard: they stop an agent from running the installers, `monitor.py`
  or the checker against the live host, or pushing to the wrong repository.
- **`policies/**`, `scripts/check-policies.mjs`, `risk-config.json`, `AGENTS.md`.**
  The rules that bound agents and the checker that enforces them. They are
  changed by the owner, never by the agent they constrain.
- **`renovate.json`.** Decides which dependency updates Renovate proposes and
  which of them wait for the owner. Its rule for `.github/workflows/**` keeps
  Tier 1 workflow updates behind owner approval on the Dependency Dashboard,
  because the merge lane merges any green PR. Loosening it lets workflow
  changes reach `main` unreviewed.
- **`LICENSE`.** GPL-3.0-or-later text; changing it changes what users may do
  with the code.
- **The root-run scripts** (`install-dns-failover.sh`,
  `tailscale-dns-failover/install.sh`, `configure.py`, `monitor.py`,
  `dns-upstream-check.py`). They run as root on a DNS server, edit
  `/etc/dnsmasq.conf`, hold OAuth credentials or write to a tailnet.
- **`dns-upstream-probe.py`, units, drop-ins, example configs, `pyproject.toml`.**
  Manual diagnosis and the configuration the scripts run under; Tier 2 because a
  mistake changes behaviour without touching Tier 1 code. See "Raise the tier".
- **Agent direction files** (`CLAUDE.md`, `.github/copilot-instructions.md`,
  `.cursor/rules/**`, `.github/prompts/**`, `.claude/skills/**`,
  `.claude/memory/**`, `.claude/session-summary.md`). They tell agents what to
  do; a loosened one loosens the agent. The session summary counts because
  CLAUDE.md and AGENTS.md have every session read it first, and it repeats the
  host rule.
- **`docs/security/**`, `docs/agent-boundaries.md`, this file.** The written
  boundary agents are judged by. They are Tier 2 so an agent cannot change
  them under the `ci` gate, even though ordinary `docs/**` is Tier 3. Edit
  them together with the policy files they describe.
- **`tests/**`, `scripts/**`.** They can hide a regression but do not ship to the
  host. `scripts/check-policies.mjs` is the exception and is Tier 1.

## Pull request notes by tier

- Tier 1 and Tier 2: state in the PR body which of the required commands ran
  and what they printed, and what could not be run (for example
  `tests/e2e/run.sh` without a container runtime).
- Tier 1 changes to a workflow: say what was verified and what could not be (a
  cron schedule cannot be proven before it fires).
- Tier 1 changes to a root-run script: say how the invariants in "What the code
  guards" were affected, even when the answer is "unchanged". Never run the
  script on a host to check; use the tests.

See also [`.github/CODEOWNERS`](../.github/CODEOWNERS) and, once it lands,
the review rubric in `docs/review-rubric.md`.
