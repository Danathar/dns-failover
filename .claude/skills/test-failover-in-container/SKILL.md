---
name: test-failover-in-container
description: Exercise dns-failover's switching logic safely, through unit tests with fakes or the throwaway-container e2e test, never on the host.
---

# test-failover-in-container

The host may be a live DNS server. Never run `sudo`, either installer,
`configure.py`, `monitor.py` (any mode), `dns-upstream-check.py` on real paths
or without `--no-reload`, or `systemctl` on dnsmasq, stubby or the units. Two
safe routes:

1. **Unit level** (default). Add a case in `tests/unit/` that calls the
   function under test with a fake `dig` result and a temp directory. For
   `dns-upstream-check.py` pass `--directory <tmp> --pid-file <tmp>/pid
   --no-reload`. For the Tailscale monitor use the fake API responses in
   `tailscale-dns-failover/test_monitor.py`. Run `python3 -m pytest`.
2. **End to end.** `tests/e2e/run.sh` starts a throwaway podman/docker
   Debian container, installs the units and runs the check script against
   stand-in listeners there. Use it after touching an installer, a unit file
   or a dnsmasq/Stubby config. Never run `tests/e2e/in-container.sh`
   directly; it is the in-container half and installs as root.

Scenarios worth covering: primary fails and backup answers (switch to 5454);
primary recovers (needs 3 healthy checks before switching back); both fail
(selection kept); stale or mismatching PID file (no signal sent); interrupted
write (no partial `servers.conf`).

Prefer encoding a scenario as a test over a one-off. Use `/var/tmp/<name>-*`
for scratch files and delete them afterwards. Any `gh` write command: pass
`--repo Danathar/dns-failover`.
