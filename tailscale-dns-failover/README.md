# Tailscale DNS override monitor

This monitor runs on the DNS server and manages **Override DNS servers** for a
whole Tailscale network. It probes the ControlD profile configured in Tailscale,
which need not be the same profile used by the local Stubby service.

## Setup

Install the local DNS failover components described in the parent README first.
The Tailscale monitor imports the local monitor's backup health check and expects
the independent Stubby backup on port 5454. The host also needs working DNS and
HTTPS access to Tailscale's API during a ControlD outage. Use an independent
resolver for the host itself to avoid relying on the failing upstream.

From this directory, install the program and units:

```sh
sudo sh ./install.sh
```

Create a Tailscale OAuth client with **DNS: Write** permission (scope `dns`).
Enter its credentials locally:

```sh
sudo python3 ./configure.py
```

The prompt saves configuration in
`/root/.config/tailscale-dns-failover/config.json` with mode 0600. The secret is
hidden during entry. It discovers the profile from the current global nameservers
and requires them all to refer to one ControlD profile. It does not enable the
timer or change Tailscale DNS settings. Credentials are not part of this package.

For automatic recovery, edit that root-only configuration and set
`"auto_restore": true`. The setup script defaults it to false, which means outages
disable override but recovery requires manually turning it back on.

Run a read-only check before enabling automation:

```sh
sudo /usr/local/sbin/tailscale-dns-failover --dry-run
sudo systemctl enable --now tailscale-dns-failover.timer
```

## Failure and recovery rules

The timer runs about every 20 seconds. Each check sends DNS-over-HTTPS queries
for example.com and cloudflare.com to the monitored profile. Either returning
an IPv4 answer counts as healthy. Both failing counts as one failed check.

After three consecutive failed checks, the monitor disables override only if
the local independent backup DNS answers. Detection normally takes about a
minute, plus the time for Tailscale to distribute the setting to clients.

With `auto_restore` enabled, five continuous minutes of healthy checks restore
override. A failure, clock reversal, or monitoring gap longer than 90 seconds
resets the recovery streak. It restores only an override it previously disabled;
starting this monitor while override is already manually off does not turn it on.

Before disabling override, the monitor saves the current DNS configuration.
Other DNS changes cancel pending restoration; a different ControlD profile stops
API updates until the configured profile is corrected. Pending recovery state
survives service restarts.

Turning override off affects the entire tailnet. Devices accepting Tailscale DNS
can use their local network's resolver, whose filtering may differ from ControlD.
The probe establishes health from the server over HTTPS; it does not test every
client's connection or transport. An unreachable Tailscale API or a failed internet
connection prevents setting changes.

## API and data handling

The program uses GET and POST on `/api/v2/tailnet/-/dns/configuration`. POST
replaces the complete object, so the program copies current settings and changes
only `preferences.overrideLocalDNS`. It preserves MagicDNS, global nameservers,
split DNS, search paths, and exit-node settings, then reads back to verify.

The API may omit false booleans and empty collections; the monitor applies their
documented defaults. The older `/dns/preferences` endpoint controls MagicDNS
and is not used here. A second read before POST catches intervening edits, but
this is not an atomic conditional update. Stop automation before manual DNS work.

State is stored in `/var/lib/tailscale-dns-failover/state.json`, mode 0600.
API attempts are limited to once per minute. OAuth access tokens are obtained as
needed and are not logged. Do not commit credentials or saved runtime state.

Official references:

- [API documentation](https://tailscale.com/api)
- [Live OpenAPI schema](https://api.tailscale.com/api/v2?outputOpenapiSchema=true)
- [OAuth clients](https://tailscale.com/docs/features/oauth-clients)

## Operation

```sh
sudo /usr/local/sbin/tailscale-dns-failover --dry-run
sudo /usr/local/sbin/tailscale-dns-failover --status
systemctl status tailscale-dns-failover.timer
journalctl -u tailscale-dns-failover.service --since '30 minutes ago'
```

`--dry-run` probes DNS and reads the API without changing settings or state.
`primary_healthy` means the Tailscale ControlD profile answered; `backup_healthy`
means the independent local listener on port 5454 answered. `--status` only reads
live API settings. The timer should show `active (waiting)`. The service is
normally inactive between checks. Successful health checks are silent; changes
and errors appear in the journal.

Stop automatic changes with:

```sh
sudo systemctl disable --now tailscale-dns-failover.timer
sudo systemctl stop tailscale-dns-failover.service
```

The remote setting stays as it was. Adjust it in Tailscale's admin console if
needed. Restart monitoring with
`sudo systemctl enable --now tailscale-dns-failover.timer`.
