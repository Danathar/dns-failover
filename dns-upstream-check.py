#!/usr/bin/env python3
"""Select ControlD while healthy; reload dnsmasq onto encrypted backup on failure."""
import argparse
import concurrent.futures
import json
import os
import re
import signal
import subprocess
from pathlib import Path


def healthy(port):
    def query(name):
        try:
            result = subprocess.run(
                ["/usr/bin/dig", "@127.0.0.1", "-p", str(port), name, "A",
                 "+time=2", "+tries=1", "+noall", "+comments", "+answer"],
                capture_output=True, text=True, timeout=3,
            )
            return (result.returncode == 0 and "status: NOERROR" in result.stdout
                    and re.search(r"\sIN\s+A\s+(?!0\.0\.0\.0\b)[0-9.]+", result.stdout) is not None)
        except subprocess.TimeoutExpired:
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(query, ("example.com", "cloudflare.com")))
    # Require both probes to fail before switching; one working domain is enough.
    return any(results)


def atomic_write(path, content):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(content)
    temp.chmod(0o644)
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", default="/run/dns-upstream")
    parser.add_argument("--pid-file", default="/run/dnsmasq/dnsmasq.pid")
    parser.add_argument("--primary-port", type=int, default=5453)
    parser.add_argument("--backup-port", type=int, default=5454)
    parser.add_argument("--no-reload", action="store_true")
    args = parser.parse_args()
    directory = Path(args.directory)
    directory.mkdir(parents=True, exist_ok=True)
    servers = directory / "servers.conf"
    state_path = directory / "state.json"
    primary = f"server=127.0.0.1#{args.primary_port}\n"
    backup = f"server=127.0.0.1#{args.backup_port}\n"
    current = servers.read_text() if servers.exists() else None
    try:
        state = json.loads(state_path.read_text())
    except (OSError, ValueError):
        state = {}
    if healthy(args.primary_port):
        successes = state.get("primary_successes", 0) + 1
        # Three healthy cycles before returning from backup to ControlD.
        desired = primary if current != backup or successes >= 3 else backup
    else:
        successes = 0
        if healthy(args.backup_port):
            desired = backup
        else:
            desired = current or primary
            print("Both upstream paths failed health checks; retaining current selection", flush=True)
    atomic_write(state_path, json.dumps({"primary_successes": min(successes, 3)}) + "\n")
    changed = current != desired
    if changed:
        atomic_write(servers, desired)
        label = "ControlD" if desired == primary else "Cloudflare Families encrypted backup"
        print(f"Selected {label} on {desired.strip()}", flush=True)
    # Retry a reload next cycle if a previous signal failed after writing the file.
    if changed or state.get("reload_pending"):
        try:
            if not args.no_reload:
                pid_path = Path(args.pid_file)
                if pid_path.exists():
                    pid = int(pid_path.read_text().strip())
                    if Path(f"/proc/{pid}/comm").read_text().strip() != "dnsmasq":
                        raise RuntimeError("PID file does not identify dnsmasq")
                    os.kill(pid, signal.SIGHUP)
        except (OSError, ValueError, RuntimeError):
            atomic_write(state_path, json.dumps({"primary_successes": min(successes, 3), "reload_pending": True}) + "\n")
            raise


if __name__ == "__main__":
    main()
