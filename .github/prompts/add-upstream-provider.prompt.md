---
description: Add or replace a DNS-over-TLS upstream provider in dns-failover
---

Add or replace the provider `${input:provider}` (a DNS-over-TLS resolver).
Today the primary is ControlD on `127.0.0.1:5453` (`stubby-primary.yml.example`)
and the backup is Cloudflare Families on `127.0.0.1:5454`
(`stubby-fallback.yml`, `stubby-fallback.service`).

1. Use only public provider addresses and documentation placeholders. Never
   add a real ControlD profile ID or any site address.
2. Add or edit the `stubby-*.yml` / `*.example` file; keep listeners on
   loopback and the ports the monitors expect (`--primary-port`,
   `--backup-port` in `dns-upstream-check.py`).
3. If the provider is diagnosed manually, extend `dns-upstream-probe.py` and
   its tests; certificate checking must stay on.
4. If ports or unit names change, update `install-dns-failover.sh`, the
   units, `dnsmasq-*.conf`, the tests and the README tables together.
5. Run `python3 -m pytest`, `ruff check .`, `git ls-files '*.sh' | xargs shellcheck`
   and `tests/e2e/run.sh`.
6. Do not start Stubby or dnsmasq on the host and do not run the installers.

Any `gh` write command passes `--repo Danathar/dns-failover`. Report what
changed, which files are Tier 1/Tier 2 and the checks you ran.
