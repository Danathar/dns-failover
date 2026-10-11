"""Offline tests for dns-upstream-check.py: fake dig, temp directory, fake /proc."""
import json
import signal
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

PRIMARY = "server=127.0.0.1#5453\n"
BACKUP = "server=127.0.0.1#5454\n"
GOOD = ";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\nexample.com.\t60\tIN\tA\t93.184.216.34\n"


class Env:
    """One simulated host: which ports answer, a fake /proc and recorded signals."""

    def __init__(self, check, tmp_path, monkeypatch):
        self.check = check
        self.monkeypatch = monkeypatch
        self.dir = tmp_path / "run"
        self.proc = tmp_path / "proc"
        self.pid_file = tmp_path / "dnsmasq.pid"
        self.up = {5453: True, 5454: True}
        self.kills = []
        self.kill_error = None
        self.dig_calls = []
        real_path = Path

        def fake_path(value):
            text = str(value)
            if text.startswith("/proc/"):
                return real_path(self.proc) / text[len("/proc/"):]
            return real_path(value)

        monkeypatch.setattr(check, "Path", fake_path)
        monkeypatch.setattr(check.subprocess, "run", self.dig)
        monkeypatch.setattr(check.os, "kill", self.kill)

    def dig(self, cmd, **_kwargs):
        port = int(cmd[cmd.index("-p") + 1])
        self.dig_calls.append(port)
        if self.up[port]:
            return SimpleNamespace(returncode=0, stdout=GOOD)
        return SimpleNamespace(returncode=9, stdout="")

    def kill(self, pid, sig):
        if self.kill_error:
            raise self.kill_error
        self.kills.append((pid, sig))

    def set_dnsmasq(self, pid=4242, comm="dnsmasq"):
        (self.proc / str(pid)).mkdir(parents=True, exist_ok=True)
        (self.proc / str(pid) / "comm").write_text(comm + "\n")
        self.pid_file.write_text(f"{pid}\n")

    def run(self, *extra, reload=True):
        argv = ["--directory", str(self.dir), "--pid-file", str(self.pid_file)]
        argv += list(extra)
        if not reload:
            argv.append("--no-reload")
        self.monkeypatch.setattr(sys, "argv", ["dns-upstream-check.py", *argv])
        self.check.main()

    @property
    def servers(self):
        return (self.dir / "servers.conf").read_text()

    @property
    def state(self):
        return json.loads((self.dir / "state.json").read_text())


@pytest.fixture
def env(check, tmp_path, monkeypatch):
    return Env(check, tmp_path, monkeypatch)


def test_first_run_selects_primary_and_signals_dnsmasq(env):
    env.set_dnsmasq()
    env.run()
    assert env.servers == PRIMARY
    assert env.kills == [(4242, signal.SIGHUP)]
    assert env.state == {"primary_successes": 1}


def test_unchanged_selection_does_not_signal(env):
    env.set_dnsmasq()
    env.run()
    env.kills.clear()
    env.run()
    assert env.servers == PRIMARY
    assert env.kills == []


def test_fails_over_to_backup_when_primary_down(env, capsys):
    env.set_dnsmasq()
    env.run()
    env.up[5453] = False
    env.kills.clear()
    env.run()
    assert env.servers == BACKUP
    assert env.kills == [(4242, signal.SIGHUP)]
    assert env.state == {"primary_successes": 0}
    assert "Cloudflare Families encrypted backup" in capsys.readouterr().out


def test_both_down_retains_current_selection(env, capsys):
    env.set_dnsmasq()
    env.run()
    env.up[5453] = env.up[5454] = False
    env.kills.clear()
    env.run()
    assert env.servers == PRIMARY
    assert env.kills == []
    assert "retaining current selection" in capsys.readouterr().out
    # Same while on backup.
    env.up[5454] = True
    env.run()
    assert env.servers == BACKUP
    env.up[5454] = False
    env.run()
    assert env.servers == BACKUP


def test_both_down_with_no_prior_selection_defaults_to_primary(env):
    env.up[5453] = env.up[5454] = False
    env.run(reload=False)
    assert env.servers == PRIMARY


def test_returns_to_primary_only_after_three_healthy_checks(env):
    env.set_dnsmasq()
    env.up[5453] = False
    env.run()
    assert env.servers == BACKUP
    env.up[5453] = True
    env.run()
    assert env.servers == BACKUP
    assert env.state["primary_successes"] == 1
    env.run()
    assert env.servers == BACKUP
    assert env.state["primary_successes"] == 2
    env.kills.clear()
    env.run()
    assert env.servers == PRIMARY
    assert env.kills == [(4242, signal.SIGHUP)]


def test_primary_blip_resets_hysteresis(env):
    env.up[5453] = False
    env.run(reload=False)
    env.up[5453] = True
    env.run(reload=False)
    env.run(reload=False)
    env.up[5453] = False
    env.run(reload=False)
    assert env.state["primary_successes"] == 0
    env.up[5453] = True
    env.run(reload=False)
    env.run(reload=False)
    assert env.servers == BACKUP


def test_state_counter_is_capped_at_three(env):
    for _ in range(6):
        env.run(reload=False)
    assert env.state == {"primary_successes": 3}


def test_corrupt_state_file_is_treated_as_empty(env):
    env.dir.mkdir(parents=True)
    (env.dir / "state.json").write_text("{not json")
    env.run(reload=False)
    assert env.state == {"primary_successes": 1}


def test_files_are_world_readable_and_written_atomically(env):
    env.run(reload=False)
    assert (env.dir / "servers.conf").stat().st_mode & 0o777 == 0o644
    assert not list(env.dir.glob("*.tmp"))


def test_no_reload_never_touches_pid_file_or_signals(env):
    env.set_dnsmasq(comm="not-dnsmasq")
    env.up[5453] = False
    env.run(reload=False)
    assert env.servers == BACKUP
    assert env.kills == []


def test_pid_file_not_dnsmasq_is_refused_and_retried(env):
    env.set_dnsmasq(comm="sshd")
    env.up[5453] = False
    with pytest.raises(RuntimeError, match="does not identify dnsmasq"):
        env.run()
    assert env.kills == []
    assert env.servers == BACKUP
    assert env.state == {"primary_successes": 0, "reload_pending": True}
    # dnsmasq is now correctly identified: the pending reload is delivered even
    # though the selection itself did not change.
    env.set_dnsmasq()
    env.run()
    assert env.kills == [(4242, signal.SIGHUP)]
    assert "reload_pending" not in env.state


def test_failed_sighup_marks_reload_pending_then_recovers(env):
    env.set_dnsmasq()
    env.kill_error = PermissionError("denied")
    with pytest.raises(PermissionError):
        env.run()
    assert env.state["reload_pending"] is True
    env.kill_error = None
    env.run()
    assert env.kills == [(4242, signal.SIGHUP)]
    assert "reload_pending" not in env.state


def test_garbage_pid_file_marks_reload_pending(env):
    env.pid_file.write_text("not-a-pid\n")
    with pytest.raises(ValueError):
        env.run()
    assert env.state["reload_pending"] is True


def test_missing_pid_file_is_not_an_error(env):
    env.run()
    assert env.servers == PRIMARY
    assert env.kills == []


def test_custom_ports_are_probed_and_written(env):
    env.up = {6001: True, 6002: True}
    env.run("--primary-port", "6001", "--backup-port", "6002", reload=False)
    assert env.servers == "server=127.0.0.1#6001\n"
    assert set(env.dig_calls) == {6001}


def test_one_working_domain_keeps_upstream_healthy(check, monkeypatch):
    def dig(cmd, **_kwargs):
        name = cmd[4]
        if name == "example.com":
            return SimpleNamespace(returncode=0, stdout="status: SERVFAIL\n")
        return SimpleNamespace(returncode=0, stdout=GOOD)

    monkeypatch.setattr(check.subprocess, "run", dig)
    assert check.healthy(5453) is True


@pytest.mark.parametrize(
    "stdout",
    [
        "status: NXDOMAIN\n",
        "status: NOERROR\n",  # no answer section
        "status: NOERROR\nexample.com. 60 IN A 0.0.0.0\n",  # blocked answer
    ],
)
def test_unhealthy_responses(check, monkeypatch, stdout):
    monkeypatch.setattr(check.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout=stdout))
    assert check.healthy(5453) is False


def test_dig_timeout_counts_as_failure(check, monkeypatch):
    def boom(*_a, **_k):
        raise subprocess.TimeoutExpired("dig", 3)

    monkeypatch.setattr(check.subprocess, "run", boom)
    assert check.healthy(5453) is False
