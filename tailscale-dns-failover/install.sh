#!/bin/sh
set -eu
stage=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -m 0755 "$stage/monitor.py" /usr/local/sbin/tailscale-dns-failover
install -m 0644 "$stage/tailscale-dns-failover.service" /etc/systemd/system/tailscale-dns-failover.service
install -m 0644 "$stage/tailscale-dns-failover.timer" /etc/systemd/system/tailscale-dns-failover.timer
systemd-analyze verify /etc/systemd/system/tailscale-dns-failover.service /etc/systemd/system/tailscale-dns-failover.timer
systemctl daemon-reload
