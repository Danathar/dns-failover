---
description: Adapt tailscale-dns-failover/monitor.py to a change in the Tailscale DNS API
---

The Tailscale DNS API (`/api/v2/tailnet/-/dns/configuration`) appears to have
changed shape, or `monitor.py` misreads a response. Fix it safely.

1. Do not call the Tailscale API yourself and do not run `monitor.py` in any
   mode (`--dry-run` uses the real credentials). Read the public docs instead:
   <https://tailscale.com/api> and the OpenAPI schema linked from
   `tailscale-dns-failover/README.md`.
2. Identify what changed: field names, defaults for omitted booleans and empty
   collections, the OAuth token flow, error codes (401/403 handling).
3. Keep the invariants: POST replaces the whole object, so copy current
   settings and change only `preferences.overrideLocalDNS`; preserve MagicDNS,
   global nameservers, split DNS, search paths and exit-node settings; read
   back to verify; at most one API attempt per minute; never log tokens.
4. Add a fake-response case to `tailscale-dns-failover/test_monitor.py` for the
   new shape; the tests stay offline and credential-free.
5. Run `python3 -m pytest` and `ruff check .`. Update
   `tailscale-dns-failover/README.md` if documented behaviour changes.

Any `gh` write command passes `--repo Danathar/dns-failover`. Report the old
versus new shape and the checks you ran.
