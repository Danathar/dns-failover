"""docs/review-rubric.md's "Failover correctness" section, held to the checker.

Reviewers check a dns-upstream-check.py change against that section's list:
how many healthy checks bring the primary back, what counts as an answer,
which files are replaced atomically, how dnsmasq is identified before it is
signalled, which flags keep tests off real paths, and which Python it targets.
test_dns_upstream_check.py drives the behaviour with those numbers written
into it, but nothing read the page, so the checklist could keep naming a
threshold, a flag or a file the checker no longer has and a reviewer would
pass a change against the wrong rule. These tests read the section and the
script and fail when either moves alone.
"""
import ast
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGE = (ROOT / "docs" / "review-rubric.md").read_text()
SOURCE = (ROOT / "dns-upstream-check.py").read_text()
TREE = ast.parse(SOURCE)
NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}


def section():
    match = re.search(r"^## 2\. Failover correctness: `dns-upstream-check\.py`\n(.*?)(?=^## )",
                      PAGE, flags=re.MULTILINE | re.DOTALL)
    assert match, "review-rubric.md has no '## 2. Failover correctness' section"
    return " ".join(match.group(1).split())


def stated(pattern):
    """The first group of pattern in section 2, which must say it."""
    match = re.search(pattern, section())
    assert match, f"review-rubric.md section 2 no longer says {pattern!r}; update this test and the page together"
    return match.group(1)


def function(name):
    [node] = [n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name == name]
    return node


def calls(node, name):
    return [c for c in ast.walk(node) if isinstance(c, ast.Call)
            and (getattr(c.func, "attr", None) == name or getattr(c.func, "id", None) == name)]


def strings(node):
    return {c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)}


def test_primary_returns_after_the_stated_number_of_healthy_checks():
    count = NUMBERS[stated(r"the primary comes back only after (\w+) consecutive healthy checks")]
    key = stated(r"healthy checks \(`(\w+)`\)")
    main = function("main")
    gates = [ast.unparse(c) for c in ast.walk(main) if isinstance(c, ast.Compare)
             and ast.unparse(c.left) == "successes" and isinstance(c.ops[0], ast.GtE)]
    assert gates == [f"successes >= {count}"]
    # The counter is persisted under the stated key, capped at the threshold
    # on every write, so it cannot grow without bound.
    caps = [c for c in calls(main, "min") if ast.unparse(c.args[0]) == "successes"]
    assert caps and all(ast.unparse(c) == f"min(successes, {count})" for c in caps)
    assert len(caps) == len(calls(main, "dumps"))
    assert f"state.get({key!r}, 0) + 1" in ast.unparse(main)


def test_one_failed_primary_check_switches_and_resets_the_counter():
    assert NUMBERS[stated(r"(\w+) failed primary check switches to the backup").lower()] == 1
    assert "keep the counter reset to zero on a failed primary check" in section()
    [branch] = [n for n in ast.walk(function("main")) if isinstance(n, ast.If)
                and ast.unparse(n.test) == "healthy(args.primary_port)"]
    failed = "\n".join(ast.unparse(s) for s in branch.orelse)
    assert failed.startswith("successes = 0\nif healthy(args.backup_port):\n    desired = backup\n")
    # Both down keeps the current selection; a first run with none takes the primary.
    assert "desired = current or primary" in failed


def test_health_means_a_noerror_answer_with_a_real_a_record_from_either_domain():
    assert stated(r"`healthy\(\)` requires `(\w+)`") == "NOERROR"
    blocked = stated(r"\(not `([0-9.]+)`, which is how a blocking resolver says no\)")
    assert "passes if either probe domain works" in section()
    healthy = function("healthy")
    assert "status: NOERROR" in strings(healthy)
    [pattern] = [s for s in strings(healthy) if "IN" in s and "A" in s and s.startswith("\\s")]
    assert f"(?!{re.escape(blocked)}\\b)" in pattern
    assert re.search(pattern, "x.\t60\tIN\tA\t93.184.216.34")
    assert not re.search(pattern, f"x.\t60\tIN\tA\t{blocked}")
    [mapped] = calls(healthy, "map")
    domains = mapped.args[1]
    assert isinstance(domains, ast.Tuple) and len(domains.elts) >= 2
    assert ast.unparse(healthy.body[-1]) == "return any(results)"


def test_the_named_files_are_only_written_through_a_same_directory_replace():
    names = set(re.findall(r"`(\w+\.(?:conf|json))`", stated(r"Writes are atomic\.\*\* (.*?) never written in place")))
    assert names == {"servers.conf", "state.json"}
    assert "`replace()`d, never written in place" in section()
    main = function("main")
    assert {s for s in strings(main) if s in names} == names
    write = function("atomic_write")
    assert ast.unparse(write.body[0]) == "temp = path.with_suffix(path.suffix + '.tmp')"
    assert ast.unparse(write.body[-1]) == "temp.replace(path)"
    # Every file the checker writes goes through atomic_write: the only
    # write_text in the script is atomic_write's own, on the temp file.
    assert [ast.unparse(c.func) for c in calls(TREE, "write_text")] == ["temp.write_text"]
    assert not calls(TREE, "open")


def test_dnsmasq_is_identified_by_comm_before_sighup():
    comm = stated(r"and `(/proc/<pid>/comm)` must say")
    expected = stated(r"must say `(\w+)` before")
    sig = stated(r"before `(SIG\w+)` is sent")
    main = ast.unparse(function("main"))
    assert f"Path(f'{comm.replace('<pid>', '{pid}')}').read_text().strip() != {expected!r}" in main
    assert "raise RuntimeError(" in main
    assert f"os.kill(pid, signal.{sig})" in main
    assert main.index("/comm") < main.index("os.kill(")
    # A missing PID file is not an error: the read is guarded by exists().
    assert "if pid_path.exists():" in main


def test_a_failed_reload_persists_the_stated_flag_and_exits_non_zero():
    flag = stated(r"`(\w+)` is persisted and the failure is surfaced")
    main = function("main")
    assert flag in strings(main)
    assert f"state.get({flag!r})" in ast.unparse(main)
    [handler] = [h for n in ast.walk(main) if isinstance(n, ast.Try) and "os.kill" in ast.unparse(n)
                 for h in n.handlers]
    assert any(isinstance(s, ast.Raise) and s.exc is None for s in handler.body)
    assert flag in strings(handler)


def test_the_listed_flags_are_the_checkers_flags():
    listed = set(re.findall(r"`(--[\w-]+)`", stated(r"Paths and ports stay arguments\.\*\* (.*?) are what let tests")))
    flags = {c.args[0].value for c in calls(TREE, "add_argument")}
    assert listed == flags


def test_python_version_and_stdlib_only_match_the_project():
    version = stated(r"Python (3\.\d+) and stdlib only")
    # The release named as the floor is one CI's unit-test matrix runs on.
    debian = stated(r"Debian (\d+) ships Python " + re.escape(version))
    assert f"debian:{debian}" in (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert project["project"]["requires-python"] == f">={version}"
    assert project["tool"]["ruff"]["target-version"] == "py" + version.replace(".", "")
    imported = {a.name.split(".")[0] for n in ast.walk(TREE) if isinstance(n, ast.Import) for a in n.names}
    imported |= {n.module.split(".")[0] for n in ast.walk(TREE) if isinstance(n, ast.ImportFrom)}
    assert imported and imported <= sys.stdlib_module_names
