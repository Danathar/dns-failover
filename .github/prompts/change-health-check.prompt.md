---
description: Change how a dns-failover monitor decides an upstream is healthy or when it switches
---

Change the health-check or switching behaviour described by `${input:change}`.
The two monitors are `dns-upstream-check.py` (local, dnsmasq upstream file,
backup after one failed primary check, return after 3 healthy checks) and
`tailscale-dns-failover/monitor.py` (3 failures to disable override, 5 healthy
minutes to restore, `auto_restore` default false). Both are Tier 1; see
`docs/risk-tiers.md`.

1. Read the function that makes the decision in the relevant monitor and the
   existing tests in `tests/unit/` or `tailscale-dns-failover/test_monitor.py`.
2. Make the smallest change. Keep the fail-safe properties: atomic file writes,
   PID check against `/proc/<pid>/comm` before SIGHUP, keep the current
   selection when both upstreams fail, check the local backup before disabling
   Tailscale override.
3. Add tests with fake `dig`/HTTP responses and temp directories that cover the
   new and the old boundary (just below and at the threshold).
4. Update the README tables (check interval, switch and return rules) so they
   match the code. Threshold changes need explicit owner approval.
5. Run `python3 -m pytest`, `ruff check .` and `tests/e2e/run.sh`.
6. Do not run either monitor on the host, even `--dry-run` (see AGENTS.md).

Any `gh` write command passes `--repo Danathar/dns-failover`. Report the old and
new behaviour and the checks you ran.
