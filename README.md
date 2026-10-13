# DNS failover for dnsmasq, Stubby, and Tailscale

[![CI](https://github.com/Danathar/dns-failover/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Danathar/dns-failover/actions/workflows/ci.yml)
[![Coverage gate](https://github.com/Danathar/dns-failover/actions/workflows/coverage-gate.yml/badge.svg?branch=main)](https://github.com/Danathar/dns-failover/actions/workflows/coverage-gate.yml)
[![Nightly compliance](https://github.com/Danathar/dns-failover/actions/workflows/nightly-compliance.yml/badge.svg?branch=main)](https://github.com/Danathar/dns-failover/actions/workflows/nightly-compliance.yml)
[![Ask DeepWiki](https://img.shields.io/badge/Ask-DeepWiki-1f6feb)](https://deepwiki.com/Danathar/dns-failover)
[![Maintenance assisted by Hivecommons Hive](https://img.shields.io/badge/maintenance%20assisted%20by-Hivecommons%20Hive-1f6feb)](https://github.com/hivecommons/hive)
[![ACMM L6 Fully Autonomous](https://img.shields.io/badge/ACMM-L6%20Fully%20Autonomous-2da44e)](#maintained-with-hive-acmm-l6)
[![AI assisted](https://img.shields.io/badge/AI-assisted-d29922)](#about-this-project)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

Keep a Linux DNS server answering during a ControlD outage, and let Tailscale
clients return to local DNS when their ControlD resolver fails.

This project combines **dnsmasq**, **Stubby**, and two small Python monitors.
The local monitor switches between encrypted upstream resolvers. The optional
Tailscale monitor changes the tailnet's DNS override setting through the API.
Recovery checks prevent an immediate switch back after a single good response.

It is intended for administrators of an existing Debian-style DNS server.
The local DNS components work without Tailscale. The Tailscale component depends
on the local backup resolver and health-check script supplied here.

- [How it works](#what-it-does)
- [Scripts and their responsibilities](#the-seven-scripts)
- [Installation](#requirements-and-installation)
- [Check operation](#check-local-dns-operation)
- [Troubleshooting](#troubleshooting)
- [Tests](#run-tests)

## What it does

There are two separate paths to protect:

1. **Local network DNS:** dnsmasq forwards internet queries to Stubby. When its
   ControlD upstream fails, a monitor switches dnsmasq to a second Stubby process
   using Cloudflare Families. It switches back after ControlD recovers.
2. **Tailscale DNS:** devices accepting Tailscale DNS can be directed to a ControlD
   profile by the tailnet's “Override DNS servers” setting. A second monitor turns
   that setting off during an outage and optionally restores it after recovery.
   Turning override off lets devices use their local network's DNS. At home this
   can be the dnsmasq server; elsewhere it depends on that network.

The two ControlD profiles can differ. Each monitor checks the appropriate path.
MagicDNS remains at its existing setting when override changes.

```text
LAN client -> dnsmasq :53 -> selected Stubby listener
                              |-- :5453 -> ControlD over TLS
                              `-- :5454 -> Cloudflare Families over TLS

Tailscale client -> ControlD while DNS override is on
                 -> local network DNS when override is off
```

| Monitor | Check interval | Switch away from ControlD | Return to ControlD |
| --- | --- | --- | --- |
| Local DNS | 5 seconds after each run | Primary check fails and backup answers | 3 consecutive healthy primary checks |
| Tailscale | 20 seconds after each run | 3 consecutive failures and local backup answers | 5 healthy minutes, if `auto_restore` is enabled |

Each health check queries two public domains; either returning an IPv4 answer
counts as success. These intervals are approximate because query execution takes
time. Tailscale setting changes also take time to reach devices.

## The seven scripts

| Script | Purpose | When it runs |
| --- | --- | --- |
| `dns-upstream-check.py` | Queries the primary Stubby listener on port 5453. If it fails and the backup on 5454 works, changes dnsmasq's upstream file and signals dnsmasq to reload. Returns to primary after three healthy checks. | Automatically through `dns-upstream-check.timer`, five seconds after each run finishes. |
| `dns-upstream-probe.py` | Sends DNS-over-TLS queries directly to ControlD and Cloudflare Families, checking TLS certificates and reporting DNS results. Accepts the ControlD profile as an argument. | Manually for diagnosis. |
| `install-dns-failover.sh` | Installs the local DNS monitor, backup Stubby configuration, and systemd units. Backs up the existing dnsmasq configuration, installs a reviewed replacement, and enables local failover. | Manually during installation; changes services immediately. |
| `tailscale-dns-failover/monitor.py` | Checks the Tailscale ControlD profile over HTTPS. Uses the Tailscale API to disable override after repeated failure and optionally restore it after recovery. | Automatically through `tailscale-dns-failover.timer`, 20 seconds after each run finishes. |
| `tailscale-dns-failover/configure.py` | Prompts for an OAuth client ID and secret, reads Tailscale DNS settings, discovers the ControlD profile, and saves root-only configuration. Refuses to overwrite an existing file. | Manually during credential setup. |
| `tailscale-dns-failover/install.sh` | Installs the Tailscale monitor and its systemd units. Does not enable its timer. | Manually during installation or an update. |
| `tailscale-dns-failover/test_monitor.py` | Runs 18 offline regression tests for outage thresholds, recovery timing, API response handling, profile matching, and preservation of other DNS settings. Makes no real API changes. | Collected by `python3 -m pytest` (still runs with `python3 -m unittest -v` inside `tailscale-dns-failover`). Manually during development or before installation. |

Installed program names are `/usr/local/sbin/dns-upstream-check` and
`/usr/local/sbin/tailscale-dns-failover`. These are copies of the two monitors,
not additional scripts.

## Supporting files

| File | Purpose |
| --- | --- |
| `dns-upstream-check.service` and `.timer` | Run and schedule the local DNS monitor. |
| `stubby-fallback.service` | Runs the independent backup Stubby process. |
| `stubby-fallback.yml` | Cloudflare Families DNS-over-TLS backup, listening on loopback port 5454. |
| `stubby-primary.yml.example` | Primary Stubby template on port 5453; replace the ControlD profile placeholder locally. |
| `dnsmasq-upstream-failover.conf` | dnsmasq service drop-in that starts the monitor first so the upstream file exists. |
| `dnsmasq-wait-online.conf` | Optional dnsmasq service drop-in for systems where LAN addresses appear late during boot. Assumes NetworkManager. |
| `dnsmasq.conf.example` | Settings to merge into a site's existing dnsmasq configuration. Contains no DHCP assignments or LAN address. |
| `dnsmasq-failover-test.conf.example` | Optional local test listener on port 5533, using a separate upstream file. Never installed by either installer. |
| `tailscale-dns-failover/tailscale-dns-failover.service` and `.timer` | Run and schedule the Tailscale monitor. |
| `tailscale-dns-failover/README.md` | Tailscale setup, API behavior, recovery rules, and operations. |
| `.gitignore` | Excludes common credential, local configuration, state, backup, and Python cache files. |

## Requirements and installation

Designed for a Debian-style Linux host with systemd, Python 3, dnsmasq, Stubby,
and `dig` at `/usr/bin/dig`. Python uses only the standard library. Installation
requires root. Paths such as Debian's dnsmasq helper and DNSSEC trust-anchor file
must be adapted for other distributions. The installers are for an existing DNS
server; they do not install packages or configure its network interfaces.

### 1. Configure the primary resolver

Run the following commands from the repository root unless stated otherwise.

First configure the primary Stubby service to listen on loopback port 5453.
Use `stubby-primary.yml.example` as a reference and substitute your own profile.
Keep customized files outside the repository or in ignored local files. Verify
that primary DNS works before enabling failover.

### 2. Prepare and install local DNS failover

Create a reviewed dnsmasq configuration outside the repository. Preserve your
own DHCP configuration, local names, listener addresses, and other site settings.
Merge `dnsmasq.conf.example` into it, replacing existing default upstream entries
with the `servers-file` setting. Retain any necessary domain-specific forwarding.
The supplied example alone serves only loopback and provides no DHCP service.

Install local failover from this folder:

```sh
sudo sh ./install-dns-failover.sh /absolute/path/to/reviewed-dnsmasq.conf
```

This enables the backup Stubby service and local monitoring timer. The initial
configuration backup is kept in `/var/lib/dns-failover-backups/`, outside the
repository. If you also need the network startup ordering fix, install
`dnsmasq-wait-online.conf` as a drop-in under
`/etc/systemd/system/dnsmasq.service.d/` and reload systemd. That optional file
is not installed automatically.

### 3. Optionally enable Tailscale failover

The DNS server must have independent DNS and HTTPS access to the Tailscale API
during a ControlD outage. Create a Tailscale OAuth client with **DNS: Write**
permission, then run from the repository root:

```sh
sudo sh ./tailscale-dns-failover/install.sh
sudo python3 ./tailscale-dns-failover/configure.py
```

The prompt saves credentials outside the checkout, in a root-only configuration
file. To restore override automatically after recovery, edit that file:

```sh
sudoedit /root/.config/tailscale-dns-failover/config.json
```

Set `"auto_restore": true`. The setup default is false, which leaves recovery
manual. Then validate the credentials and health:

```sh
sudo /usr/local/sbin/tailscale-dns-failover --dry-run
```

After the dry run succeeds, enable the timer:

```sh
sudo systemctl enable --now tailscale-dns-failover.timer
```

This affects the whole tailnet. Devices must accept Tailscale DNS settings.
Automatic recovery normally applies only after the monitor itself disabled
override; it does not take ownership of an already manually disabled setting.
See [the Tailscale operating guide](tailscale-dns-failover/README.md) for API
behavior, manual controls, and details about recovery.

## Check local DNS operation

```sh
systemctl status dns-upstream-check.timer stubby-fallback.service
journalctl -u dns-upstream-check.service --since '10 minutes ago'
cat /run/dns-upstream/servers.conf
dig @127.0.0.1 -p 5453 example.com
dig @127.0.0.1 -p 5454 example.com
dig @127.0.0.1 example.com
python3 ./dns-upstream-probe.py --controld-profile YOUR_CONTROLD_PROFILE_ID
```

Port 5453 is primary; 5454 is backup. The selected port appears in
`/run/dns-upstream/servers.conf`. The monitor queries example.com and cloudflare.com;
either successful IPv4 answer counts as healthy. A single failed check switches
to a working backup. Three healthy checks restore the primary. If both fail,
the monitor retains the current selection and logs the problem. This cannot
restore connectivity when the internet connection itself is down.

To suspend local switching, stop the timer and then the service:

```sh
sudo systemctl disable --now dns-upstream-check.timer
sudo systemctl stop dns-upstream-check.service
```

The current upstream remains selected. Restart monitoring with
`sudo systemctl enable --now dns-upstream-check.timer`.

The optional test configuration expects
`/tmp/dns-failover-test/servers.conf` to exist. Create that directory and a file
containing `server=127.0.0.1#5453` before using it. Its listener is loopback port
5533, separate from production DNS. Its DNSSEC settings include a public root
trust anchor from the original test; keep trust anchors current for future use.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Primary fails but backup works | The selected upstream file should show port 5454. Check the local monitor journal if it does not. |
| Both upstreams fail | Check internet connectivity and the Stubby journals. The monitor keeps its previous selection when neither path works. |
| Direct LAN DNS works but a Tailscale client fails | Compare a query to the LAN server with one to `100.100.100.100` on that client. Run the Tailscale monitor's `--dry-run` on the server. |
| A monitoring service shows inactive | This is normal between runs. Check that its timer is active and inspect the last service result and journal. |
| Tailscale API returns 401 or 403 | Check the OAuth credential and its DNS permission. Stop the timer before replacing credentials or changing DNS manually. |
| Override does not come back on | Check `auto_restore`, the five-minute health period, and whether this monitor originally disabled override. Other DNS edits can cancel restoration. |
| DNS fails after reboot | Check service logs and listener addresses. The optional network startup drop-in is for a server that starts dnsmasq before its LAN address is ready. |

Health checks observe the upstreams from the server, not from every client.
Neither monitor can fix a lost internet connection. The backup provider and the
local DNS available away from home can have different filtering from ControlD.

## Run tests

From the repository root (Python 3.11 or newer; `pytest`, `ruff`, `shellcheck`
and `coverage` are development tools only, the product code uses just the
standard library):

```sh
python3 -m pytest                                          # all unit tests
ruff check .                                               # lint (config in pyproject.toml)
git ls-files -z '*.sh' | xargs -0 shellcheck               # shell lint (config in .shellcheckrc)
python3 -m coverage run -m pytest && python3 -m coverage report   # coverage floor from pyproject.toml
tests/e2e/run.sh                                           # end-to-end test in a throwaway container
```

The unit tests use fake `dig` output, fake API responses, temporary directories
and a fake `/proc`; they need no credentials, network, root access or running
services. `tests/e2e/run.sh` starts a Debian container (podman or docker) in
which real dnsmasq processes act as the two upstreams and a frontend, and the
real `dns-upstream-check.py` switches between them. Neither touches the host's
DNS, systemd units or Tailscale. Live health and API access are checked
separately with the installed monitor's `--dry-run`, by a person, on the
server.

Contributors, human or AI agent, should read [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md) first; they cover the checks above and what must
never be run on the host.

## What was removed for sharing

Personal ControlD profile IDs and their encoded IPv6 addresses, LAN addresses,
host and device names, MAC addresses, tailnet names, email addresses, repository
URLs, live OAuth credentials, operational state, backups, and the host admin log
are not included. Public provider addresses, loopback addresses, official API
URLs, and documentation-only examples remain because they explain the software.
Keep site-specific files and secrets outside version control when adapting this project.

## Maintained with Hive (ACMM L6)

Maintenance is assisted by [Hivecommons Hive](https://github.com/hivecommons/hive), which runs a fleet of AI agents against this repo at ACMM level 6 (Fully Autonomous). The repository is maintained by [@Danathar](https://github.com/Danathar).

**What L6 permits here:** agents file issues and open pull requests, and agent pull requests merge once their required checks pass unless they carry `hold`. Tier 1 and Tier 2 changes (the failover scripts, units, workflows and policies) need the owner to read and merge them; docs and tests need only passing CI. The reviewer agent comments with file and line references but never approves, merges or closes anything.

See [`docs/branch-protection.md`](docs/branch-protection.md) for the required checks, [`docs/risk-tiers.md`](docs/risk-tiers.md) for which changes need a human, [`docs/multi-agent.md`](docs/multi-agent.md) for how agents share the repo and [`docs/agent-boundaries.md`](docs/agent-boundaries.md) for what an agent may change without the owner.

Learn more: [Hive](https://github.com/hivecommons/hive) · [Hive Hub](https://hive.kubestellar.io) · [ACMM levels](https://github.com/hivecommons/hive#acmm-levels) · [full ACMM policy matrix](https://github.com/hivecommons/hive/blob/v4/src/docs/acmm-policy-matrix.md)

## About this project

> [!NOTE]
> This project was developed with AI assistance and should be treated cautiously. It is not affiliated with or endorsed by ControlD, Tailscale, dnsmasq or Stubby. It comes as-is. It changes a running DNS server's resolver configuration and, if the Tailscale part is enabled, the tailnet's DNS override setting through the Tailscale API. Read the scripts and units before you install them, test on a non-critical server first, and keep a copy of your existing dnsmasq and Stubby configuration.

## License

GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
