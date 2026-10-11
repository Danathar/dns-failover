---
description: Review a pull request against dns-failover's safety rules
---

Review PR `${input:pr}` using `gh pr view`/`gh pr diff` with
`--repo Danathar/dns-failover`. Do not push to the contributor's branch.

Check, citing file and function names (not bare line numbers):

1. Host rule: nothing in the PR runs or documents running `sudo`, the
   installers, `configure.py`, `monitor.py` (including `--dry-run`), or
   `dns-upstream-check.py` on real paths without `--no-reload` as a test step.
2. Fail-safe behaviour: atomic writes, PID check before SIGHUP, selection kept
   when both upstreams fail, installer restores the dnsmasq backup on failure,
   Tailscale 3-failure threshold and `auto_restore` default false.
3. No site specifics or secrets: ControlD profile IDs, LAN addresses,
   hostnames, tailnet names, OAuth values.
4. Python 3.11 standard library only; POSIX `sh`; ruff and shellcheck clean.
5. Tests cover the changed behaviour; e2e was run if installers, units or
   configs changed; CI is green on a branch current with `main`.
6. Risk tier is stated and matches `docs/risk-tiers.md`.
7. README and docs match the code; every `gh` write command in docs carries
   `--repo Danathar/dns-failover`.
8. Scope: unrelated changes are disclosed in the PR body.

Output: verdict (approve / request changes), findings by severity, and the
checks you ran. Comment only; do not merge.
