"""Each product script, launched as a program, fails cleanly on bad input.

The other unit tests import the scripts and call their functions, so the code
that runs only when a script is launched (its `if __name__ == "__main__":`
block: argument parsing, the top-level error handler, the exit status) is run
by no test. That code is how a failed run reaches systemd: the monitor's
handler prints one `tailscale-dns-failover: <Type>: <message>` line, keeps the
traceback (and anything else) out of the journal, and exits 1.

Every script in `[tool.coverage.run].include` needs a row in LAUNCHES (run
here in a child Python process) or in LAUNCHED_ELSEWHERE (an existing test
already executes it as `__main__`). Adding a product script without deciding
how it fails turns test_every_product_script_is_launched red.

Host rule (AGENTS.md): each row fails before the script reads any real path,
runs a command or talks to the network. The child process also replaces every
socket connect with an error, so a row that drifted past its failure point
would fail the test instead of reaching the live Tailscale API.
"""
import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
MONITOR_PREFIX = "tailscale-dns-failover: "

# Run the script as __main__ with every outbound connection refused. `-I` keeps
# the user's site-packages and the working directory off sys.path.
LAUNCHER = """\
import runpy, socket, sys

def refuse(*_args, **_kwargs):
    raise PermissionError("network blocked by test_entry_points")

socket.socket.connect = socket.socket.connect_ex = refuse
socket.create_connection = socket.getaddrinfo = refuse
script = sys.argv[1]
sys.argv = sys.argv[1:]
runpy.run_path(script, run_name="__main__")
"""


def config_with_mode(tmp_path, mode):
    path = tmp_path / "config.json"
    path.write_text('{"tailnet": "-", "client_id": "id-placeholder", "client_secret": "secret-placeholder",'
                    ' "expected_resolver_id": "profile-placeholder"}\n')
    path.chmod(mode)
    return path


# script, id, argument builder (tmp_path -> list), exit status, stderr start,
# strings that must not appear in stdout or stderr.
LAUNCHES = [
    ("tailscale-dns-failover/monitor.py", "monitor-missing-config",
     lambda tmp: ["--config", str(tmp / "missing.json"), "--state", str(tmp / "state.json")],
     1, MONITOR_PREFIX + "FileNotFoundError:", ()),
    ("tailscale-dns-failover/monitor.py", "monitor-config-readable-by-others",
     lambda tmp: ["--config", str(config_with_mode(tmp, 0o644)), "--state", str(tmp / "state.json")],
     1, MONITOR_PREFIX + "RuntimeError: Credential configuration must have permissions 0600\n",
     ("secret-placeholder", "id-placeholder")),
    ("dns-upstream-probe.py", "probe-no-arguments",
     lambda tmp: [],
     2, "usage:", ()),
    ("dns-upstream-probe.py", "probe-profile-not-alphanumeric",
     lambda tmp: ["--controld-profile", "not.alnum"],
     2, "usage:", ()),
    ("dns-upstream-check.py", "check-port-not-a-number",
     lambda tmp: ["--directory", str(tmp / "run"), "--pid-file", str(tmp / "dnsmasq.pid"),
                  "--no-reload", "--primary-port", "not-a-number"],
     2, "usage:", ()),
]

# Scripts with no __main__ block that already run as __main__ in another test.
LAUNCHED_ELSEWHERE = {
    # Prompts for credentials at import time; the host rule forbids launching
    # it for real, and run_configure executes it as __main__ with fakes.
    "tailscale-dns-failover/configure.py": "tests/unit/test_configure.py",
}


def product_scripts():
    with open(ROOT / "pyproject.toml", "rb") as f:
        return set(tomllib.load(f)["tool"]["coverage"]["run"]["include"])


def test_every_product_script_is_launched():
    declared = {row[0] for row in LAUNCHES} | set(LAUNCHED_ELSEWHERE)
    missing = sorted(product_scripts() - declared)
    assert not missing, f"add a LAUNCHES row saying how these fail when launched: {missing}"
    stale = sorted(script for script in declared if not (ROOT / script).is_file())
    assert not stale, f"LAUNCHES names scripts that no longer exist: {stale}"


@pytest.mark.parametrize("script, test", sorted(LAUNCHED_ELSEWHERE.items()))
def test_launched_elsewhere_still_runs_as_main(script, test):
    source = (ROOT / test).read_text()
    assert Path(script).name in source and 'run_name="__main__"' in source, (
        f"{test} no longer executes {script} as __main__; give it a LAUNCHES row instead")


@pytest.mark.parametrize("script, args, status, start, absent",
                         [pytest.param(*row[:1], *row[2:], id=row[1]) for row in LAUNCHES])
def test_launch_fails_cleanly(tmp_path, script, args, status, start, absent):
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(tmp_path), "LC_ALL": "C.UTF-8"}
    result = subprocess.run([sys.executable, "-I", "-c", LAUNCHER, str(ROOT / script), *args(tmp_path)],
                            cwd=tmp_path, env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=30)
    output = result.stdout + result.stderr
    assert result.returncode == status, output
    assert result.stderr.startswith(start), output
    assert "Traceback" not in output
    assert "network blocked" not in output
    for text in absent:
        assert text not in output
    if script.endswith("monitor.py"):
        assert result.stdout == "" and result.stderr.count("\n") == 1, output
