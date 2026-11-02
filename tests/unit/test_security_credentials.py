"""docs/security/SECURITY-AI.md's "Credentials" subsection, held to the code.

The subsection tells agents and the owner where the Tailscale OAuth secret
lives and how it is kept root-only: the path configure.py creates, the file and
directory modes, the service's UMask and state directory mode, and that
auto_restore stays off. policies/credential-safety.json checks pieces of each
file on its own, but nothing checked that the files agree with each other or
with the page. configure.py, monitor.py and the unit's ConditionPathExists each
spell the config path separately, and the configure.py tests redirect any path
ending in config.json, so configure.py could write a file the monitor never
reads and the service would skip every run without an error. These tests read
the page and each file and fail when any of them moves alone.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TAILSCALE = ROOT / "tailscale-dns-failover"
PAGE = (ROOT / "docs" / "security" / "SECURITY-AI.md").read_text()
CONFIGURE = (TAILSCALE / "configure.py").read_text()
MONITOR = (TAILSCALE / "monitor.py").read_text()
SERVICE = (TAILSCALE / "tailscale-dns-failover.service").read_text()


def credentials():
    match = re.search(r"^### Credentials\n(.*?)(?=^### )", PAGE, flags=re.MULTILINE | re.DOTALL)
    assert match, "SECURITY-AI.md has no '### Credentials' subsection"
    return " ".join(match.group(1).split())


def find(pattern, text, where):
    match = re.search(pattern, text, flags=re.MULTILINE)
    assert match, f"{where} no longer matches {pattern!r}; update this test and SECURITY-AI.md together"
    return match.group(1)


def unit(key):
    return find(rf"^{key}=(\S+)$", SERVICE, "tailscale-dns-failover.service")


def calls(source, name):
    """Every call to a function or method called name in source."""
    return [node for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Call)
            and (getattr(node.func, "attr", None) == name or getattr(node.func, "id", None) == name)]


def octal(node):
    assert isinstance(node, ast.Constant) and isinstance(node.value, int), ast.unparse(node)
    return f"{node.value:04o}"


def test_config_path_is_one_path_everywhere():
    stated = find(r"creates `(/[^`]+)` exclusively", credentials(), "SECURITY-AI.md Credentials")
    assert find(r"^path = Path\('([^']+)'\)$", CONFIGURE, "configure.py") == stated
    assert find(r"^CONFIG = Path\('([^']+)'\)$", MONITOR, "monitor.py") == stated
    assert unit("ConditionPathExists") == stated


def test_monitor_state_lives_in_the_unit_state_directory():
    state = Path(find(r"^STATE = Path\('([^']+)'\)$", MONITOR, "monitor.py"))
    assert state.parent == Path("/var/lib") / unit("StateDirectory")


def test_config_is_created_exclusively_with_the_stated_modes():
    text = credentials()
    file_mode, dir_mode = re.search(r"with mode (0\d{3}) in a (0\d{3}) directory", text).groups()
    assert "(refusing to overwrite)" in text
    assert re.search(r"^if path\.exists\(\):\n\s+raise SystemExit\(", CONFIGURE, flags=re.MULTILINE)
    [opened] = calls(CONFIGURE, "open")
    assert "os.O_EXCL" in ast.unparse(opened.args[1])
    assert octal(opened.args[2]) == file_mode
    [made] = calls(CONFIGURE, "mkdir")
    assert [octal(k.value) for k in made.keywords if k.arg == "mode"] == [dir_mode]


def test_service_umask_and_state_directory_mode_match_the_page():
    umask, state_mode = re.search(r"runs with `UMask=(\d+)` and a (0\d{3}) state directory", credentials()).groups()
    assert unit("UMask") == umask
    assert unit("StateDirectoryMode") == state_mode


def test_configure_never_prints_the_secret():
    assert "never prints the secret" in credentials()
    for call in calls(CONFIGURE, "print"):
        assert "client_secret" not in ast.unparse(call)


def test_auto_restore_is_written_false_and_read_false_when_missing():
    text = credentials()
    assert "`configure.py` writes it `false`" in text
    assert "`monitor.py` reads a missing value as `false`" in text
    written = [value for node in ast.walk(ast.parse(CONFIGURE)) if isinstance(node, ast.Dict)
               for key, value in zip(node.keys, node.values, strict=True)
               if isinstance(key, ast.Constant) and key.value == "auto_restore"]
    assert [ast.unparse(v) for v in written] == ["False"]
    reads = [c for c in calls(MONITOR, "get") if c.args and getattr(c.args[0], "value", None) == "auto_restore"]
    assert reads, "monitor.py no longer reads auto_restore with .get(); update this test and SECURITY-AI.md together"
    for read in reads:
        assert len(read.args) == 2 and ast.unparse(read.args[1]) == "False", ast.unparse(read)
    assert not re.search(r"\[['\"]auto_restore['\"]\]", MONITOR), "monitor.py indexes auto_restore, so a missing value raises"
