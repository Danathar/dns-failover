---
name: handle-tailscale-api-change
description: Diagnose and fix tailscale-dns-failover/monitor.py when the Tailscale DNS API changes shape or the monitor misreads a response.
---

# handle-tailscale-api-change

Symptoms: 400/401/403 or parse errors in
`journalctl -u tailscale-dns-failover.service` (reported by a user, never
fetched by you), override not toggling, settings lost after a toggle.

1. Do not call the API and do not run `monitor.py` or `configure.py` (the
   host rule; `--dry-run` uses real credentials). Read the public docs
   <https://tailscale.com/api> and the schema linked from
   `tailscale-dns-failover/README.md`.
2. Compare with what `monitor.py` reads and writes:
   `/api/v2/tailnet/-/dns/configuration`, `preferences.overrideLocalDNS`,
   defaults applied for omitted false booleans and empty collections, the
   OAuth client-credentials token request.
3. Fix the parsing in `monitor.py`. Never "fix" it by sending a partial object:
   POST replaces the whole configuration, so the monitor must copy current
   settings and change only `overrideLocalDNS`, then read back.
4. Add a fake-response test in `tailscale-dns-failover/test_monitor.py` with the
   new shape. Run `python3 -m pytest` and `ruff check .`.
5. Update `tailscale-dns-failover/README.md` if documented behaviour changes.

See also `.github/prompts/tailscale-api-change.prompt.md`. `monitor.py` is
Tier 1 (`docs/risk-tiers.md`). Any `gh` write command: pass
`--repo Danathar/dns-failover`.
