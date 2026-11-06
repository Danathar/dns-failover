#!/usr/bin/env bash
# End-to-end test of dns-upstream-check.py against real dnsmasq processes.
#
# Meant to run as root inside a throwaway Debian container (tests/e2e/run.sh
# starts one locally; the CI job's container runs it directly). It never runs
# on a developer host: it starts and kills dnsmasq processes and writes below
# /run and /tmp.
#
#   fake primary   dnsmasq 127.0.0.1:5453  example.com -> 192.0.2.1,    cloudflare.com -> 192.0.2.2
#   fake backup    dnsmasq 127.0.0.1:5454  example.com -> 198.51.100.1, cloudflare.com -> 198.51.100.2
#   frontend       dnsmasq 127.0.0.1:5300  servers-file=<monitor dir>/servers.conf, own pid file
#
# The real dns-upstream-check.py picks the upstream and SIGHUPs the frontend.
#
# Step 5 also runs the real install-dns-failover.sh, to hold what its rollback
# leaves on disk. A plain container has no systemd, stubby or dnsmasq.service,
# so systemctl, systemd-analyze and systemd-helper are stand-ins there: that
# step shows the file handling, not that units start on a real server.
set -euo pipefail

SRC=${SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
WORK=$(mktemp -d)
# dnsmasq drops to its own user and must be able to traverse to servers.conf.
chmod 0755 "$WORK"
RUN=$WORK/dns-upstream
FRONT_PID=$WORK/frontend.pid
CHECK=("$SRC/dns-upstream-check.py" --directory "$RUN" --pid-file "$FRONT_PID")

if [ "$(id -u)" -ne 0 ]; then
    echo "in-container.sh must run as root in a throwaway container" >&2
    exit 1
fi

if ! command -v dnsmasq >/dev/null || ! command -v dig >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    # No init system here: keep the package from trying to start a service.
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod +x /usr/sbin/policy-rc.d
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends dnsmasq dnsutils python3 procps >/dev/null
fi

cleanup() {
    for f in "$WORK"/*.pid; do
        if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null || true; fi
    done
    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    for f in "$WORK"/*.log; do
        [ -f "$f" ] && { echo "--- $f" >&2; cat "$f" >&2; }
    done
    ls -l "$RUN" >&2 || true
    exit 1
}

pass() {
    echo "ok - $*"
}

start_upstream() { # name port example-ip cloudflare-ip
    dnsmasq --conf-file=/dev/null --no-resolv --no-hosts --bind-interfaces \
        --listen-address=127.0.0.1 --port="$2" --cache-size=0 \
        --address="/example.com/$3" --address="/cloudflare.com/$4" \
        --pid-file="$WORK/$1.pid" --log-facility="$WORK/$1.log"
}

# A killed daemon is reparented to PID 1, which in a CI job container does not
# reap children, so it lingers as a zombie that `kill -0` still accepts.
alive() {
    local state
    state=$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null) || return 1
    [ -n "$state" ] && [ "$state" != Z ]
}

stop_upstream() {
    local pid
    pid=$(cat "$WORK/$1.pid")
    kill "$pid"
    while alive "$pid"; do sleep 0.1; done
}

selected() {
    sed -n 's/^server=127.0.0.1#//p' "$RUN/servers.conf"
}

run_check() {
    python3 "${CHECK[@]}"
}

# The frontend answers from whichever upstream servers.conf names. SIGHUP is
# handled asynchronously, so poll briefly.
expect_answer() { # expected-address
    local got=""
    for _ in $(seq 1 50); do
        got=$(dig @127.0.0.1 -p 5300 example.com A +short +time=2 +tries=1 2>/dev/null || true)
        [ "$got" = "$1" ] && return 0
        sleep 0.1
    done
    fail "frontend answered '${got}', expected $1"
}

expect_selected() { # port
    [ "$(selected)" = "$1" ] || fail "servers.conf selects '$(selected)', expected $1"
}

start_upstream primary 5453 192.0.2.1 192.0.2.2
start_upstream backup 5454 198.51.100.1 198.51.100.2

# The monitor creates servers.conf on its first run; dnsmasq needs it to exist
# at startup, so run once without a reload, then start the frontend.
python3 "${CHECK[@]}" --no-reload
expect_selected 5453
dnsmasq --conf-file=/dev/null --no-resolv --no-hosts --bind-interfaces \
    --listen-address=127.0.0.1 --port=5300 --cache-size=0 \
    --servers-file="$RUN/servers.conf" --pid-file="$FRONT_PID" \
    --log-facility="$WORK/frontend.log"
expect_answer 192.0.2.1
pass "healthy primary: frontend answers from ControlD stand-in"

# 1. Primary dies, backup healthy: switch immediately and reload the frontend.
stop_upstream primary
run_check
expect_selected 5454
expect_answer 198.51.100.1
pass "primary down: switched to backup, frontend answers from backup"

# 2. Primary returns: stay on backup for two healthy checks, return on the third.
start_upstream primary 5453 192.0.2.1 192.0.2.2
run_check
expect_selected 5454
run_check
expect_selected 5454
expect_answer 198.51.100.1
run_check
expect_selected 5453
expect_answer 192.0.2.1
pass "primary back: hysteresis held for two checks, returned on the third"

# 3. Both down: the current selection is kept rather than flapping.
stop_upstream primary
stop_upstream backup
out=$(run_check 2>&1) || fail "check exited non-zero with both upstreams down: $out"
case $out in *"retaining current selection"*) ;; *) fail "no retain message: $out" ;; esac
expect_selected 5453
pass "both down: selection retained"

# 3b. Same while on backup: fail over, then lose the backup too.
start_upstream backup 5454 198.51.100.1 198.51.100.2
run_check
expect_selected 5454
stop_upstream backup
run_check >/dev/null
expect_selected 5454
pass "both down while on backup: backup retained"

# 4. A PID file that does not name dnsmasq must not be signalled.
start_upstream primary 5453 192.0.2.1 192.0.2.2
start_upstream backup 5454 198.51.100.1 198.51.100.2
sleep 300 &
sleeper=$!
echo "$sleeper" > "$WORK/wrongpid.pid"
if python3 "$SRC/dns-upstream-check.py" --directory "$WORK/other" --pid-file "$WORK/wrongpid.pid" >/dev/null 2>&1; then
    kill "$sleeper" 2>/dev/null || true
    fail "check accepted a PID file that is not dnsmasq"
fi
kill -0 "$sleeper" || fail "non-dnsmasq process was signalled"
kill "$sleeper" 2>/dev/null || true
grep -q '"reload_pending": true' "$WORK/other/state.json" || fail "reload_pending not recorded"
pass "PID file for a non-dnsmasq process refused; reload left pending"

# 5. The installer's rollback. The script, cp, install and dnsmasq --test are
# real. The systemctl stand-in fails a restart while the installed config has
# the marker: the start-up failure that dnsmasq --test cannot see.
if [ -d /run/systemd/system ]; then
    fail "systemd is running here, so this may be a real server: not running the installer"
fi
BACKUPS=/var/lib/dns-failover-backups
ORIGINAL=$BACKUPS/dnsmasq.conf.before-failover
STUBS=$WORK/stubs
mkdir -p "$STUBS" /usr/share/dnsmasq
cat > "$STUBS/systemctl" <<'STUB'
#!/bin/sh
if [ "$1" = restart ] && grep -q e2e-fails-to-start /etc/dnsmasq.conf; then
    exit 1
fi
STUB
printf '#!/bin/sh\n' > "$STUBS/systemd-analyze"
printf '#!/bin/sh\n' > /usr/share/dnsmasq/systemd-helper
chmod +x "$STUBS/systemctl" "$STUBS/systemd-analyze" /usr/share/dnsmasq/systemd-helper
printf '# site settings\n' > "$WORK/site.expected"
printf '# reviewed config\n' > "$WORK/good.conf"
printf '# newer reviewed config\n' > "$WORK/newer.conf"
printf '# e2e-fails-to-start\n' > "$WORK/bad.conf"

installer_succeeds() {
    PATH="$STUBS:$PATH" sh "$SRC/install-dns-failover.sh" "$1" >>"$WORK/installer.log" 2>&1 ||
        fail "installer failed with $1"
}

installer_fails() {
    if PATH="$STUBS:$PATH" sh "$SRC/install-dns-failover.sh" "$WORK/bad.conf" >"$WORK/installer.log" 2>&1; then
        fail "installer exited zero with a config that does not start"
    fi
    grep -q 'dnsmasq\.conf\.last-good' "$WORK/installer.log" || fail "installer did not say what it restored"
}

expect_link() {
    [ "$(readlink "$1")" = "$2" ] || fail "$1 is not a link to $2: $(ls -l "$1")"
}

expect_file() {
    [ ! -L "$1" ] || fail "$1 is a link: $(ls -l "$1")"
    cmp -s "$1" "$2" || fail "$1 does not match $2"
}

# A fresh server whose /etc/dnsmasq.conf is the link $1 to the file $2.
linked_host() {
    rm -rf "$BACKUPS" /etc/dnsmasq.conf
    cp "$WORK/site.expected" "$2"
    ln -s "$1" /etc/dnsmasq.conf
}

# 5a. Symlinked config, two failed runs in a row: the link and the file it
# points to both come back, each time.
# 5b. Symlinked config, a good run, then a failed one: the good run left a
# regular file, which must come back, and the saved link must not be written
# through into the site's own file.
# A relative link dangles in the backup directory, so both shapes are tried.
for link in "$WORK/site.conf" dnsmasq-site.conf; do
    case $link in
        /*) target=$link ;;
        *) target=/etc/$link ;;
    esac
    linked_host "$link" "$target"
    for _ in 1 2; do
        installer_fails
        expect_link /etc/dnsmasq.conf "$link"
        expect_file "$target" "$WORK/site.expected"
        expect_link "$ORIGINAL" "$link"
    done
    pass "symlink to $link: two failed runs restore the link and its target"

    linked_host "$link" "$target"
    installer_succeeds "$WORK/good.conf"
    expect_file /etc/dnsmasq.conf "$WORK/good.conf"
    installer_fails
    expect_file /etc/dnsmasq.conf "$WORK/good.conf"
    expect_file "$target" "$WORK/site.expected"
    expect_link "$ORIGINAL" "$link"
    pass "symlink to $link: a later failed run leaves the site's file alone"
done

# 5c. Regular config: a failed re-run restores what was working a moment ago,
# not the first-install original, which stays as it was.
rm -rf "$BACKUPS" /etc/dnsmasq.conf
cp "$WORK/site.expected" /etc/dnsmasq.conf
installer_succeeds "$WORK/good.conf"
installer_succeeds "$WORK/newer.conf"
installer_fails
expect_file /etc/dnsmasq.conf "$WORK/newer.conf"
expect_file "$ORIGINAL" "$WORK/site.expected"
pass "regular config: a failed re-run restores the last good config"

echo "E2E PASSED"
