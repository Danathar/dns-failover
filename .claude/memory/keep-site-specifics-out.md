# Keep site-specific values out of this public repository

**Date:** 2026-10-11
**Wrong:** pasting a real ControlD profile ID, LAN address, tailnet name, OAuth
client ID/secret or hostname into a test, example, doc, issue or PR body
"because it makes the example realistic" or "to reproduce".
**Right:** this repository is public and was published with those values
removed (README "What was removed for sharing"). Examples use placeholders
(`*.example` files; the documentation-range address `192.0.2.53` and the
placeholder profile `profile` in `FakeAPI` and `MonitorTests` of the unit tests). Real values live outside version control on the host:
`/root/.config/tailscale-dns-failover/config.json` (root-only, written by
`configure.py`) and the operator's own `dnsmasq.conf` and `stubby-primary.yml`
copied from the `.example` files. If a value is needed to explain a bug, describe
its kind (a ControlD profile ID, a private LAN address) and not the value; use
RFC 5737 documentation addresses (192.0.2.0/24) in examples. A
secret that reaches a commit, issue or PR must be reported to the owner at once
and rotated; deleting it from a later commit does not remove it from history.
**Why it matters:** a leaked OAuth secret grants `dns` scope on the tailnet; a
profile ID and LAN layout describe the owner's network to anyone.
**Evidence:** README section "What was removed for sharing"; `*.example` files
at the repository root; `FakeAPI` and `MonitorTests` in `tailscale-dns-failover/test_monitor.py`.
