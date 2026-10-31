"""README.md's "What it does" and "The seven scripts" sections, held to the code.

Both sections give numbers an operator plans around: how often each monitor
runs, how many failed or healthy checks move it, which ports the two Stubby
listeners use, and how many offline tests guard the Tailscale monitor. Nothing
read them, and the test count had gone stale: the README said 18 while
tailscale-dns-failover/test_monitor.py has held 19 since the throttle fix
(#66) added one. These tests read each number out of the page and out of the
script, timer or test file it describes, so a change to either has to change
the other in the same commit.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = (ROOT / "README.md").read_text()
STRATEGY = (ROOT / "docs" / "strategy.md").read_text()
CHECK = (ROOT / "dns-upstream-check.py").read_text()
MONITOR = (ROOT / "tailscale-dns-failover" / "monitor.py").read_text()

WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def number(text):
    return int(text) if text.isdigit() else WORDS[text.lower()]


def section(heading):
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## )", README, flags=re.MULTILINE | re.DOTALL)
    assert match, f"README.md has no '## {heading}' section"
    return match.group(1)


def table(text):
    """Rows of the first Markdown table in text, as lists of cell strings, header and rule dropped."""
    lines = [line for line in text.splitlines() if line.startswith("|")]
    return [[cell.strip() for cell in line.strip("|").split("|")] for line in lines[2:]]


def find(pattern, text, where):
    match = re.search(pattern, text, flags=re.MULTILINE)
    assert match, f"{where} no longer matches {pattern!r}; update this test and README.md together"
    return match.group(1)


def timer_interval(relative):
    return int(find(r"^OnUnitInactiveSec=(\d+)s$", (ROOT / relative).read_text(), relative))


def scripts_rows():
    return {re.fullmatch(r"`([^`]+)`", row[0]).group(1): row for row in table(section("The seven scripts"))}


def monitor_rows():
    return {row[0]: row for row in table(section("What it does"))}


def test_scripts_table_lists_every_script_once():
    heading = find(r"^## The (\w+) scripts$", README, "README.md")
    on_disk = {
        str(path.relative_to(ROOT))
        for folder in (ROOT, ROOT / "tailscale-dns-failover")
        for pattern in ("*.py", "*.sh")
        for path in folder.glob(pattern)
    }
    assert set(scripts_rows()) == on_disk
    assert len(table(section("The seven scripts"))) == number(heading) == len(on_disk)


def test_local_monitor_row_matches_its_ports_threshold_and_timer():
    row = " ".join(scripts_rows()["dns-upstream-check.py"])
    primary = find(r'"--primary-port", type=int, default=(\d+)\)', CHECK, "dns-upstream-check.py")
    backup = find(r'"--backup-port", type=int, default=(\d+)\)', CHECK, "dns-upstream-check.py")
    assert f"listener on port {primary}." in row
    assert f"the backup on {backup} works" in row
    healthy = find(r"successes >= (\d+) else backup", CHECK, "dns-upstream-check.py")
    assert number(find(r"Returns to primary after (\w+) healthy checks\.", row, "the README row")) == int(healthy)
    seconds = number(find(r"(\w+) seconds after each run finishes", row, "the README row"))
    assert seconds == timer_interval("dns-upstream-check.timer")


def test_tailscale_monitor_row_matches_its_timer():
    row = " ".join(scripts_rows()["tailscale-dns-failover/monitor.py"])
    seconds = number(find(r"(\w+) seconds after each run finishes", row, "the README row"))
    assert seconds == timer_interval("tailscale-dns-failover/tailscale-dns-failover.timer")


def test_monitor_table_matches_the_thresholds_and_timers():
    rows = monitor_rows()
    local, tailscale = rows["Local DNS"], rows["Tailscale"]
    assert local[1] == f"{timer_interval('dns-upstream-check.timer')} seconds after each run"
    assert tailscale[1] == f"{timer_interval('tailscale-dns-failover/tailscale-dns-failover.timer')} seconds after each run"
    healthy = int(find(r"successes >= (\d+) else backup", CHECK, "dns-upstream-check.py"))
    assert local[3] == f"{healthy} consecutive healthy primary checks"
    failures = int(find(r"state\['failures'\] < (\d+) or not backup_ok", MONITOR, "monitor.py"))
    assert tailscale[2] == f"{failures} consecutive failures and local backup answers"
    restore = int(find(r"now - state\['healthy_since'\] >= (\d+)\)", MONITOR, "monitor.py"))
    assert restore % 60 == 0
    assert tailscale[3] == f"{restore // 60} healthy minutes, if `auto_restore` is enabled"


def test_both_monitors_query_the_domain_count_the_page_states():
    count = number(find(r"^Each health check queries (\w+) public domains", section("What it does"), "README.md"))
    for name, text in (("dns-upstream-check.py", CHECK), ("monitor.py", MONITOR)):
        domains = ast.literal_eval(find(r"pool\.map\(query, (\([^)]*\))\)", text, name))
        assert len(domains) == count, name


def test_offline_test_count_matches_test_monitor():
    tree = ast.parse((ROOT / "tailscale-dns-failover" / "test_monitor.py").read_text())
    tests = [
        node.name
        for cls in tree.body if isinstance(cls, ast.ClassDef)
        for node in cls.body if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
    ]
    row = " ".join(scripts_rows()["tailscale-dns-failover/test_monitor.py"])
    assert int(find(r"Runs (\d+) offline regression tests", row, "the README row")) == len(tests)
    # docs/strategy.md repeats the count in its risk list; its dated status table keeps the old reading.
    assert int(find(r"by the (\d+) offline tests in", STRATEGY, "docs/strategy.md")) == len(tests)


def test_installer_rows_match_what_each_installer_enables():
    local = (ROOT / "install-dns-failover.sh").read_text()
    tailscale = (ROOT / "tailscale-dns-failover" / "install.sh").read_text()
    assert "enables local failover" in " ".join(scripts_rows()["install-dns-failover.sh"])
    assert re.search(r"^systemctl enable --now dns-upstream-check\.timer$", local, flags=re.MULTILINE)
    assert "Does not enable its timer." in " ".join(scripts_rows()["tailscale-dns-failover/install.sh"])
    assert "systemctl enable" not in tailscale


def test_installed_names_are_copies_of_the_two_monitors():
    names = find(r"^Installed program names are ([\s\S]*?)\. These are copies", README, "README.md")
    stated = re.findall(r"`([^`]+)`", names)
    installed = [
        find(r'^install -m 0755 "\$stage/dns-upstream-check\.py" (\S+)$',
             (ROOT / "install-dns-failover.sh").read_text(), "install-dns-failover.sh"),
        find(r'^install -m 0755 "\$stage/monitor\.py" (\S+)$',
             (ROOT / "tailscale-dns-failover" / "install.sh").read_text(), "tailscale-dns-failover/install.sh"),
    ]
    assert stated == installed
