# Copilot instructions

Full rules: [AGENTS.md](../AGENTS.md). Essentials:

- This repo is Python 3 (stdlib only), POSIX `sh` installers and systemd units
  for a dnsmasq + Stubby DNS server with ControlD primary and Cloudflare
  Families backup. `dns-upstream-check.py` switches dnsmasq upstreams;
  `tailscale-dns-failover/monitor.py` toggles Tailscale "Override DNS servers".
- **Host rule:** never run `sudo`, `install-dns-failover.sh`,
  `tailscale-dns-failover/install.sh`, `configure.py`, `monitor.py` (even
  `--dry-run`, it hits the live Tailscale API), `dns-upstream-check.py` on real
  paths or without `--no-reload`, `systemctl`/`service` on dnsmasq/stubby/the
  units, or any Tailscale API call. Test with `python3 -m pytest` and
  `tests/e2e/run.sh` (throwaway container).
- Never add real ControlD profile IDs, addresses, hostnames, tailnet names or
  credentials anywhere.
- Python 3.11+ stdlib only; new code must pass `ruff check .`, and shell code
  `git ls-files '*.sh' | xargs shellcheck`.
- Add/update a test for each behaviour change; keep README accurate.
- Conventional Commits. Any `gh` write command needs `--repo Danathar/dns-failover`.
- Licence is GPL-3.0-or-later.
