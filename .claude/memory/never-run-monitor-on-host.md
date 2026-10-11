# `monitor.py --dry-run` is live: never run the monitor on the host

**Date:** 2026-10-11
**Wrong:** treating `tailscale-dns-failover/monitor.py --dry-run` (or `--status`)
as a safe way to "see what the monitor would do". No incident is recorded in the
history; the hazard is in the code and in the README's own troubleshooting
advice (which tells the operator, not an agent, to run
`/usr/local/sbin/tailscale-dns-failover --dry-run`).
**Right:** `main` in `tailscale-dns-failover/monitor.py` reads the root-only
config (`/root/.config/tailscale-dns-failover/config.json`), builds a `Client`
and, in `--dry-run`, calls `Client.get`, which runs `Client.authenticate`: a real
OAuth `client_credentials` request to `api.tailscale.com` with the real client
ID and secret, then a read of the tailnet's DNS configuration. `--status` does
the same read. Only the PUT is skipped. Without those flags, `tick` can turn the
tailnet-wide "Override DNS servers" setting off for every device. Also,
`main` loads the installed `/usr/local/sbin/dns-upstream-check` with
`runpy.run_path`, so it runs host code. To exercise the monitor:

- unit tests: `python3 -m pytest tailscale-dns-failover/test_monitor.py`
  (also runs under `python3 -m unittest`) drives `tick` and `Client` with fake
  API responses and no network;
- end to end: `tests/e2e/run.sh` in a throwaway container, never with real
  credentials;
- syntax and lint only: `ruff check .`, `bash -n` and `shellcheck` on the
  installers.

Credentials are never put in the repository, in a test, or in a command line an
agent runs. The same applies to the installers and `configure.py`, which write
`/etc`, enable timers and store the OAuth secret.
**Why it matters:** it uses live credentials against the live tailnet and the
API call cannot be undone by reverting a commit. A mistaken non-dry run can
disable DNS override for every device on the tailnet.
**Evidence:** `main`, `Client.authenticate`, `Client.get`, `tick` in
`tailscale-dns-failover/monitor.py`; `.claude/hooks/guard-bash.mjs` (header lists
the exact rule) and `.claude/hooks/tests/guard-bash.test.mjs` (cases for
`monitor.py` in every spelling, including the installed name).
