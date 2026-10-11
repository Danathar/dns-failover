# Contributing

Thanks for helping. This project keeps a Debian-style DNS server answering
during a ControlD outage; see [README.md](README.md) for what it does and
[AGENTS.md](AGENTS.md) for the rules that apply to humans and AI agents alike.
Contributions are licensed GPL-3.0-or-later, like the rest of the repo.

## Ground rules

- **Do not test on a live DNS server.** Do not run the installers,
  `configure.py`, `monitor.py` (not even `--dry-run`: it uses real credentials
  against the live Tailscale API), or `dns-upstream-check.py` against
  `/run/...` or without `--no-reload` on a machine that serves DNS. Use the
  unit tests (`tests/unit/`, `tailscale-dns-failover/test_monitor.py`) and the
  throwaway-container end-to-end test (`tests/e2e/run.sh`).
- **Keep site specifics out.** No real ControlD profile IDs, LAN addresses,
  hostnames, tailnet names, MAC addresses or credentials in code, tests,
  issues or PRs. Use documentation placeholders.
- The failover safety behaviour (atomic file writes, PID check before SIGHUP,
  keep selection when both upstreams fail, installer backup restore, the
  Tailscale 3-failure threshold, `auto_restore` default false) is a safety
  property. Changes need maintainer sign-off.
- Python is standard library only and must run on Python 3.11. Shell is POSIX `sh`.

## Setup

For development: Python 3.11+ with `pytest`, `coverage` and `ruff`;
[`shellcheck`](https://www.shellcheck.net/); podman or docker for the
end-to-end test; Node 22 for the repo-meta scripts and hook tests.

## Before you open a PR

```bash
python3 -m pytest
ruff check .
git ls-files '*.sh' | xargs shellcheck
node scripts/check-policies.mjs
```

If you touched an installer, a unit file or the dnsmasq/Stubby configs, also
run `tests/e2e/run.sh`. For coverage:
`python3 -m coverage run -m pytest && python3 -m coverage report`. If you
touched `scripts/` or `.claude/hooks/`, run `node --test 'scripts/tests/*.test.mjs'` and
`node --test '.claude/hooks/tests/*.test.mjs'`. CI (`ci.yml`, `coverage-gate.yml`,
`policy-check.yml`, `agent-tooling.yml` in `.github/workflows/`) runs the same
checks. Add or update a test for each behaviour change and update the README
if user-visible behaviour or configuration changes.

Changes are classified by risk; see [docs/risk-tiers.md](docs/risk-tiers.md).
Tier 1 and Tier 2 paths need owner review.

## Commits and PRs

- Conventional Commits (`fix:`, `feat:`, `docs:`, `test:`, `ci:`, `chore:`).
- One logical change per PR; fill in the PR template with the exact commands
  you ran and what you did not verify.
- If an AI tool helped, say so in the PR description.

## Reporting bugs and requesting features

Use the issue templates. For a bug, name the component, your distro, dnsmasq
and Stubby versions, and journal excerpts with site specifics redacted
(`journalctl -u dns-upstream-check.service` or
`journalctl -u tailscale-dns-failover.service`). Report security problems
privately via GitHub's "Report a vulnerability" on the Security tab.
