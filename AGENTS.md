# AGENTS.md

Authoritative instructions for every AI coding agent working in this repo
(Claude Code, GitHub Copilot, Cursor, Codex, others). Tool-specific files
([CLAUDE.md](CLAUDE.md), [.github/copilot-instructions.md](.github/copilot-instructions.md),
[.cursor/rules/dns-failover.mdc](.cursor/rules/dns-failover.mdc)) only point
here; if they disagree with this file, this file wins.

## What this repo is

Python 3 (standard library only) plus POSIX `sh` installers and systemd units
for an existing Debian-style DNS server running dnsmasq and Stubby. Licence:
GPL-3.0-or-later (see `LICENSE`). Default branch: `main`. The README states
that site specifics were removed for sharing; keep it that way.

| Component | What it does |
|---|---|
| `dns-upstream-check.py` | Runs as root about every 5 s from `dns-upstream-check.timer`. Digs the primary Stubby listener (`127.0.0.1:5453`, ControlD) and the backup (`5454`, Cloudflare Families), writes `/run/dns-upstream/servers.conf` and `state.json` atomically, then SIGHUPs dnsmasq (PID file checked against `/proc/<pid>/comm`). Switches to the backup after one failed primary check if the backup answers, returns after 3 healthy primary checks, keeps the current selection if both fail. Options: `--directory --pid-file --primary-port --backup-port --no-reload`. |
| `dns-upstream-probe.py` | Manual DNS-over-TLS diagnosis against ControlD and Cloudflare (uses the network). |
| `install-dns-failover.sh` | Root installer: backs up `/etc/dnsmasq.conf`, installs units, runs `dnsmasq --test`, installs the reviewed config, restores the backup if the check or restart fails, enables the timer. |
| `tailscale-dns-failover/monitor.py` | Root, about every 20 s. Checks ControlD over HTTPS; through the Tailscale API (OAuth) turns the tailnet-wide "Override DNS servers" off after 3 failures if the local backup answers; restores it after 5 healthy minutes only if `auto_restore` is true (default false). |
| `tailscale-dns-failover/configure.py` | Prompts for the OAuth client ID and secret, writes the root-only config file, refuses to overwrite. |
| `tailscale-dns-failover/install.sh` | Installs the Tailscale monitor and its units; does not enable the timer. |
| `tailscale-dns-failover/test_monitor.py` | Offline unittest tests with fake API responses. |
| `*.service`, `*.timer`, `dnsmasq-*.conf`, `stubby-*.yml`, `*.example` | systemd units, dnsmasq drop-ins, Stubby configs and templates. |

## Host rule (hard rule)

The development machine may also be a real DNS server. **Agents never run, on
the host:**

- `sudo`;
- `install-dns-failover.sh` or `tailscale-dns-failover/install.sh`;
- `tailscale-dns-failover/configure.py`;
- `tailscale-dns-failover/monitor.py` in any mode. `--dry-run` is not safe:
  it still uses the real credentials against the live Tailscale API;
- `dns-upstream-check.py` against real paths (`/run/...`, the real dnsmasq PID
  file) or without `--no-reload`;
- `systemctl` or `service` actions on dnsmasq, stubby or this project's units;
- any Tailscale API call.

Code is exercised only through the unit tests (fakes, stubs, temp
directories) and the end-to-end test inside a throwaway container
(`tests/e2e/run.sh`). Never run `tests/e2e/in-container.sh` directly: it is
the in-container half and installs things as root. Credentials and
site-specific values (ControlD profile IDs, LAN addresses, hostnames, tailnet
names, OAuth secrets, MAC addresses) never enter the repo, issues, PRs or
chat. Use documentation placeholders only. The Bash guard in
`.claude/hooks/` blocks these commands for Claude Code; the rule binds every
other tool too.

## Other hard rules

- Do not weaken fail-safe behaviour: `dns-upstream-check.py` must write its
  files atomically, must verify the PID file against `/proc/<pid>/comm`
  before signalling, and must keep the current selection when both upstreams
  fail. The installer must keep restoring the dnsmasq backup when
  `dnsmasq --test` or the restart fails. The Tailscale monitor must keep its
  3-failure threshold, its check that the local backup answers before it
  disables override, and `auto_restore` defaulting to false. Changing any
  threshold needs explicit owner approval and README updates.
- Python stays standard-library only and must run on Python 3.11 (Debian 12).
  Shell stays POSIX `sh`.
- Never commit secrets or tokens. Do not `git commit -s`; use Conventional
  Commits (`fix:`, `feat:`, `docs:`, `test:`, `ci:`, `chore:`).
- Every `gh` write command passes `--repo Danathar/dns-failover`. Never act
  on any other repository.
- Do not edit repo settings, labels or rulesets; do not merge your own PRs.
- Use `git -C <dir>` or absolute paths instead of `cd`, and `/var/tmp/<name>-*`
  instead of `/tmp` for scratch work.
- Disclose any change beyond what was asked in the PR description.
- Cite code by function or symbol name, never by bare line numbers; they go
  stale.

## Testing and checks

Run from the repo root:

```bash
python3 -m pytest                  # tests/unit/ and tailscale-dns-failover/test_monitor.py
ruff check .                       # lint, config in pyproject.toml
git ls-files '*.sh' | xargs shellcheck   # config in .shellcheckrc
tests/e2e/run.sh                   # throwaway podman/docker container
python3 -m coverage run -m pytest && python3 -m coverage report   # floor: fail_under in pyproject.toml
node --test 'scripts/tests/*.test.mjs'         # repo-meta script tests
node --test '.claude/hooks/tests/*.test.mjs'   # hook tests
node scripts/check-policies.mjs    # policy-as-code
```

`ruff format` is not enforced (it would rewrite product code). CI
(`.github/workflows/ci.yml`, `coverage-gate.yml`, `policy-check.yml`,
`agent-tooling.yml`) runs the same checks; its job names are the required
status checks, so do not rename them. Run `tests/e2e/run.sh` when you touch an
installer, a unit file or the dnsmasq/Stubby configs. Add or update a test
for every behaviour change. Repo-meta automation (hook, metrics, audit,
policy checker) is Node `.mjs`, stdlib only; product code and its tests are
Python.

## Risk tiers

Changes are classified by what they touch; the full list is in
[docs/risk-tiers.md](docs/risk-tiers.md) (machine-readable in
`risk-config.json`).

- **Tier 1, critical** (owner review, all checks): workflows, `CODEOWNERS`,
  rulesets, `.claude/settings.json` and hooks, `policies/`,
  `scripts/check-policies.mjs`, `risk-config.json`, `LICENSE`, `AGENTS.md`,
  both installers, `configure.py`, `monitor.py`, `dns-upstream-check.py`.
- **Tier 2, high** (owner review): `dns-upstream-probe.py`, units, dnsmasq and
  Stubby configs, `pyproject.toml`, tool-specific agent files, skills, memory,
  the session summary, `docs/security/`.
- **Tier 3, standard:** everything else.

## Where things go

| Path | What it is |
|---|---|
| `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/dns-failover.mdc` | Thin pointers to this file |
| `.github/prompts/` | Reusable prompt files (see its README) |
| `.claude/skills/` | Claude skills: `run-checks`, `test-failover-in-container`, `handle-tailscale-api-change` |
| `.claude/settings.json`, `.claude/hooks/` | Claude permissions and the Bash guard hook |
| `.claude/memory/` | Durable cross-session knowledge |
| `.claude/session-summary.md` | Session state (see Session continuity) |
| `docs/reflections/` | Lessons learned write-ups |
| `docs/agent-tasks/` | Task briefs for agents |
| `docs/multi-agent.md`, `docs/ai-ops-runbook.md` | How agents coordinate; operations runbook |
| `docs/agent-boundaries.md`, `docs/security/SECURITY-AI.md` | What agents may do; AI security policy |
| `policies/` | Policy-as-code, enforced by `node scripts/check-policies.mjs` |
| `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/` | PR and issue templates |

`node scripts/check-policies.mjs` requires the literal
`--repo Danathar/dns-failover` on every `gh` write command in Markdown. Run it
after editing agent docs.

## Session continuity

Session state lives in `.claude/session-summary.md`. At the start of work
read it, `.claude/memory/` and recent `git log`. Only the session that lands
work on `main` rewrites the summary (see the end-of-session rule at the top of
that file); a session that opens a PR to be merged later puts its notes (what
was done, what is in flight, next steps) in the PR body, so concurrent PRs do
not conflict. Record durable lessons in `.claude/memory/`, not in chat. Any
agent (not only Claude) should treat these as the shared handoff point.

## Pull requests

Use the PR template. List the exact checks you ran with results, say what you
did not verify, confirm the host rule was respected, and note that the PR was
prepared by an AI agent. State the risk tier. Changes to the failover logic,
installers or Tailscale monitor are Tier 1: run the full check list including
`tests/e2e/run.sh`.
