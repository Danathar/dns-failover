"""Offline tests for tailscale-dns-failover/configure.py.

The script runs at import time against a fixed root-owned path, so each test
re-executes it with that path redirected into a temp directory and the Tailscale
client replaced by a fake. No credentials or network are involved.
"""
import json
import pathlib
import runpy
import stat
from pathlib import Path

import monitor
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "tailscale-dns-failover" / "configure.py"


def run_configure(monkeypatch, tmp_path, answers=("id-1", "secret-1"), nameservers=None):
    target = tmp_path / "conf" / "config.json"
    real = pathlib.Path

    def fake_path(value):
        return target if str(value).endswith("/config.json") else real(value)

    monkeypatch.setattr(pathlib, "Path", fake_path)
    monkeypatch.setattr("builtins.input", lambda _prompt: answers[0])
    monkeypatch.setattr("getpass.getpass", lambda _prompt: answers[1])
    seen = {}

    class FakeClient:
        def __init__(self, config):
            seen["config"] = config

        def get(self):
            return {"nameservers": nameservers if nameservers is not None else []}

    monkeypatch.setattr(monitor, "Client", FakeClient)
    monkeypatch.setattr(monitor, "resolver_id", lambda address: address)
    runpy.run_path(str(SCRIPT), run_name="__main__")
    return target, seen


def test_writes_root_only_config_with_auto_restore_off(monkeypatch, tmp_path, capsys):
    target, seen = run_configure(monkeypatch, tmp_path, nameservers=[{"address": "abc123"}])
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
    config = json.loads(target.read_text())
    assert config["auto_restore"] is False
    assert config["expected_resolver_id"] == "abc123"
    assert config["client_id"] == "id-1"
    assert seen["config"]["tailnet"] == "-"
    out = capsys.readouterr().out
    assert "Automation is not enabled" in out
    assert "secret-1" not in out


def test_refuses_to_overwrite_existing_config(monkeypatch, tmp_path):
    target = tmp_path / "conf" / "config.json"
    target.parent.mkdir()
    target.write_text("keep me")
    with pytest.raises(SystemExit, match="already exists"):
        run_configure(monkeypatch, tmp_path)
    assert target.read_text() == "keep me"


def test_requires_both_credentials(monkeypatch, tmp_path):
    with pytest.raises(SystemExit, match="Both credentials"):
        run_configure(monkeypatch, tmp_path, answers=("id-1", "  "))
    assert not (tmp_path / "conf" / "config.json").exists()


@pytest.mark.parametrize("nameservers", [[], [{"address": "a"}, {"address": "b"}]])
def test_unexpected_nameservers_save_nothing(monkeypatch, tmp_path, nameservers):
    with pytest.raises(SystemExit, match="credentials not saved"):
        run_configure(monkeypatch, tmp_path, nameservers=nameservers)
    assert not (tmp_path / "conf" / "config.json").exists()
