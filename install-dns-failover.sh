#!/bin/sh
set -eu
stage=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd)
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
    echo "Usage: $0 /absolute/path/to/reviewed-dnsmasq.conf" >&2
    exit 1
fi
config=$1
original=/var/lib/dns-failover-backups/dnsmasq.conf.before-failover
backup=/var/lib/dns-failover-backups/dnsmasq.conf.last-good
mkdir -p /var/lib/dns-failover-backups
chmod 0700 /var/lib/dns-failover-backups
mkdir -p /etc/stubby /etc/systemd/system/dnsmasq.service.d
# $original is the config from before the first install and is never replaced.
# $backup is the config running now, saved on every run: the rollback target.
# /etc/dnsmasq.conf may be a symlink. cp -a keeps it one, and such a copy can
# dangle here, so -L is checked too. --remove-destination stops a copy going
# through a link saved by an earlier run into the file it points to.
if [ ! -e "$original" ] && [ ! -L "$original" ]; then
    cp -a /etc/dnsmasq.conf "$original"
fi
cp -a --remove-destination /etc/dnsmasq.conf "$backup"
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
    echo "dnsmasq failed with $config; restoring the config from the start of this run: $backup" >&2
    cp -a --remove-destination "$backup" /etc/dnsmasq.conf
    systemctl restart dnsmasq.service
    exit 1
fi
systemctl enable --now dns-upstream-check.timer
systemctl is-active dnsmasq.service stubby.service stubby-fallback.service dns-upstream-check.timer
