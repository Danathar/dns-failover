#!/bin/sh
set -eu
stage=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Usage: $0 /absolute/path/to/reviewed-dnsmasq.conf" >&2
    exit 1
fi
config=$1
backup=/var/lib/dns-failover-backups/dnsmasq.conf.before-failover
mkdir -p /var/lib/dns-failover-backups
chmod 0700 /var/lib/dns-failover-backups
mkdir -p /etc/stubby /etc/systemd/system/dnsmasq.service.d
if [ ! -e "$backup" ]; then
    cp -a /etc/dnsmasq.conf "$backup"
fi
install -m 0755 "$stage/dns-upstream-check.py" /usr/local/sbin/dns-upstream-check
install -m 0644 "$stage/stubby-fallback.yml" /etc/stubby/fallback.yml
install -m 0644 "$stage/stubby-fallback.service" /etc/systemd/system/stubby-fallback.service
install -m 0644 "$stage/dns-upstream-check.service" /etc/systemd/system/dns-upstream-check.service
install -m 0644 "$stage/dns-upstream-check.timer" /etc/systemd/system/dns-upstream-check.timer
install -m 0644 "$stage/dnsmasq-upstream-failover.conf" /etc/systemd/system/dnsmasq.service.d/upstream-failover.conf
systemd-analyze verify /etc/systemd/system/stubby-fallback.service /etc/systemd/system/dns-upstream-check.service /etc/systemd/system/dns-upstream-check.timer
systemctl daemon-reload
systemctl enable --now stubby-fallback.service
systemctl start dns-upstream-check.service
dnsmasq --test --conf-file="$config"
install -m 0644 "$config" /etc/dnsmasq.conf
if ! /usr/share/dnsmasq/systemd-helper checkconfig || ! systemctl restart dnsmasq.service; then
    install -m 0644 "$backup" /etc/dnsmasq.conf
    systemctl restart dnsmasq.service
    exit 1
fi
systemctl enable --now dns-upstream-check.timer
systemctl is-active dnsmasq.service stubby.service stubby-fallback.service dns-upstream-check.timer
