"""The Tailscale monitor's dependency on the installed local monitor.

tailscale-dns-failover/monitor.py does not import dns-upstream-check.py. On
every run, main() executes the *installed* copy with runpy.run_path, takes its
`healthy` function and calls it with the backup Stubby port. Nothing else ties
the two together: they are installed by different scripts. A moved install
path or a renamed function stops every run at once. A changed signature or a
different backup port is quieter: `healthy` is only called once ControlD is
already failing, so it would surface during an outage, which is when the
check is needed.

These tests hold the pieces to each other: the path main() loads is the path
install-dns-failover.sh installs to; main() can call the repository's
dns-upstream-check.py the way it calls the installed copy, and the port it
asks about is the backup port the local monitor uses; and that port is where
the backup Stubby listens.
"""
import json
import re
import runpy
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import monitor
import pytest

ROOT = Path(__file__).resolve().parents[2]
GOOD = ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\nexample.com.\t60\tIN\tA\t93.184.216.34\n"


def installed_path(installer, source):
    """Destination an installer's `install -m <mode> "$stage/<source>" <dest>` line writes."""
    text = (ROOT / installer).read_text()
    match = re.search(rf'^install -m \d+ "\$stage/{re.escape(source)}" (\S+)$', text, flags=re.MULTILINE)
    assert match, f"{installer} no longer installs {source}"
    return match.group(1)


@pytest.fixture
def monitor_run(tmp_path, monkeypatch):
    """Run monitor.main() offline with ControlD failing.

    The path main() asks runpy for is recorded, and the repository's
    dns-upstream-check.py is loaded in its place, so main() calls the real
    `healthy` by the name and with the arguments it uses in production. dig is
    faked; the ports it is asked about are recorded.
    """
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"expected_resolver_id": "profile"}))
    config.chmod(0o600)
    record = SimpleNamespace(loaded=[], probed=[], ticks=[])
    real_run_path = runpy.run_path

    def dig(cmd, **_kwargs):
        record.probed.append(int(cmd[cmd.index("-p") + 1]))
        return SimpleNamespace(returncode=0, stdout=GOOD)

    def run_path(path):
        record.loaded.append(path)
        return real_run_path(str(ROOT / "dns-upstream-check.py"))

    monkeypatch.setattr(monitor.runpy, "run_path", run_path)
    monkeypatch.setattr(subprocess, "run", dig)
    monkeypatch.setattr(monitor, "profile_healthy", lambda _profile: False)
    monkeypatch.setattr(monitor, "tick", lambda *args: record.ticks.append(args))
    monkeypatch.setattr(sys, "argv", ["monitor.py", "--config", str(config), "--state", str(tmp_path / "state.json")])
    monitor.main()
    return record


def local_monitor_backup_port(check, tmp_path, monkeypatch):
    """The port dns-upstream-check.py probes as its backup when run with its defaults."""
    probed = []

    def dig(cmd, **_kwargs):
        port = int(cmd[cmd.index("-p") + 1])
        probed.append(port)
        return SimpleNamespace(returncode=9, stdout="")  # every upstream down

    monkeypatch.setattr(check.subprocess, "run", dig)
    monkeypatch.setattr(sys, "argv", ["dns-upstream-check.py", "--directory", str(tmp_path / "run"), "--no-reload"])
    check.main()
    primary, backup = dict.fromkeys(probed)
    assert primary == 5453, "the primary probe is expected first"
    return backup


def test_the_monitor_loads_the_local_check_from_where_the_installer_puts_it(monitor_run):
    assert monitor_run.loaded == [installed_path("install-dns-failover.sh", "dns-upstream-check.py")]
    assert len(monitor_run.ticks) == 1


def test_the_monitor_probes_the_local_backup_through_the_installed_healthy(monitor_run, check, tmp_path, monkeypatch):
    backup = local_monitor_backup_port(check, tmp_path, monkeypatch)
    # Both health-check domains, each against the local monitor's backup port.
    assert monitor_run.probed == [backup, backup]


def test_the_backup_port_is_where_the_backup_stubby_listens(check, tmp_path, monkeypatch):
    backup = local_monitor_backup_port(check, tmp_path, monkeypatch)
    listen = re.findall(r"^\s*-\s*127\.0\.0\.1@(\d+)\s*$", (ROOT / "stubby-fallback.yml").read_text(), flags=re.MULTILINE)
    assert listen == [str(backup)]
