"""docs/review-rubric.md's "Tailscale override ownership" section, held to the monitor.

Reviewers check a monitor.py or configure.py change against that section's
list: how many failures turn the override off, when ownership is recorded, what
cancels a restoration, which reads surround a write, and what resets a streak.
test_monitor.py drives most of that behaviour with the numbers written into it,
but nothing read the page, so the checklist could keep stating a rule the
monitor no longer keeps and a reviewer would pass a change against it. These
tests take the numbers and names from the section, drive tick() through a fake
API that records the order of events, and fail when either side moves alone.
"""
import ast
import copy
import re
from pathlib import Path

import monitor
import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = (ROOT / "docs" / "review-rubric.md").read_text()
TAILSCALE = ROOT / "tailscale-dns-failover"
MONITOR = ast.parse((TAILSCALE / "monitor.py").read_text())
CONFIGURE = (TAILSCALE / "configure.py").read_text()
NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
PROFILE = "example"
STEP = 20  # The monitor's timer interval, well inside the gap that resets a streak.
LONG_GAP = 3600


def section():
    match = re.search(r"^## 3\. Tailscale override ownership: `monitor\.py` and `configure\.py`\n(.*?)(?=^## )",
                      PAGE, flags=re.MULTILINE | re.DOTALL)
    assert match, "review-rubric.md has no '## 3. Tailscale override ownership' section"
    return " ".join(match.group(1).split())


def stated(pattern):
    """The first group of pattern in section 3, which must say it."""
    match = re.search(pattern, section())
    assert match, f"review-rubric.md section 3 no longer says {pattern!r}; update this test and the page together"
    return match.group(1)


def says(*phrases):
    for phrase in phrases:
        assert phrase in section(), f"review-rubric.md section 3 no longer says {phrase!r}; update this test and the page"


def failures_needed():
    return NUMBERS[stated(r"turned off only after (\w+) consecutive primary failures")]


def healthy_seconds():
    return NUMBERS[stated(r"restores only after (\w+) healthy minutes")] * 60


def dns(override=True, search="example.test"):
    return {"nameservers": [{"address": f"https://dns.controld.com/{PROFILE}", "useWithExitNode": False}],
            "splitDNS": {}, "searchPaths": [search],
            "preferences": {"overrideLocalDNS": override, "magicDNS": True}}


class FakeAPI:
    """The tailnet's DNS configuration, and the order things happened to it."""

    def __init__(self, value):
        self.value = copy.deepcopy(value)
        self.events = []
        self.after_first_get = None  # Someone else's edit, between the two reads.
        self.lose_response = False
        self.ignore_write = False

    def get(self):
        self.events.append("get")
        result = copy.deepcopy(self.value)
        if self.after_first_get is not None:
            self.value, self.after_first_get = self.after_first_get, None
        return result

    def put(self, value):
        self.events.append("put")
        if not self.ignore_write:
            self.value = copy.deepcopy(value)
        if self.lose_response:
            raise RuntimeError("response lost")

    def writes(self):
        return self.events.count("put")


class Monitor:
    """tick() on a clock, with every persist recorded in the API's event list."""

    def __init__(self, api, auto_restore=None, state=None):
        self.api = api
        self.config = {"expected_resolver_id": PROFILE}
        if auto_restore is not None:
            self.config["auto_restore"] = auto_restore
        self.state = state if state is not None else {}
        self.now = 1000
        self.saved = []

    def persist(self, value):
        self.api.events.append("persist")
        self.saved.append(copy.deepcopy(value))

    def tick(self, primary_ok, backup_ok=True, step=STEP):
        self.now += step
        monitor.tick(self.config, self.state, primary_ok, backup_ok, self.now, self.api, self.persist)

    def fail(self, count, backup_ok=True):
        for _ in range(count):
            self.tick(False, backup_ok)

    def disabled_by_the_monitor(self):
        self.fail(failures_needed())
        assert self.api.value["preferences"]["overrideLocalDNS"] is False
        assert "restore_config" in self.state
        self.state.pop("next_api_attempt")
        return self

    def almost_healed(self):
        """One second short of the stated wait, in steps too small to reset the streak."""
        self.tick(True)
        start = self.now
        while self.now - start < healthy_seconds() - STEP:
            self.tick(True)
        self.tick(True, step=STEP - 1)
        assert self.now - self.state["healthy_since"] == healthy_seconds() - 1

    def heal(self):
        self.almost_healed()
        self.tick(True, step=1)


def test_the_override_goes_off_on_the_stated_failure_only_when_the_backup_answers():
    says("**and** a working local backup", "a first failure, or a failed backup, does nothing")
    api = FakeAPI(dns())
    run = Monitor(api)
    run.fail(failures_needed() - 1)
    assert api.events == [], "the monitor touched the API before the stated number of failures"
    run.fail(1)
    assert api.writes() == 1
    assert api.value["preferences"]["overrideLocalDNS"] is False
    assert {k: v for k, v in api.value.items() if k != "preferences"} == {k: v for k, v in dns().items() if k != "preferences"}

    api = FakeAPI(dns())
    Monitor(api).fail(failures_needed() + 2, backup_ok=False)
    assert api.events == [], "the monitor acted without a working backup"


def test_the_failures_must_be_consecutive():
    api = FakeAPI(dns())
    run = Monitor(api)
    for _ in range(3):
        run.fail(failures_needed() - 1)
        run.tick(True)
    assert api.events == []


def test_ownership_is_saved_and_persisted_before_the_write():
    says("`restore_config` is saved and persisted before the API write",
         "the write can succeed even if its response is lost")
    api = FakeAPI(dns())
    run = Monitor(api)
    run.fail(failures_needed())
    write = api.events.index("put")
    assert "persist" in api.events[:write]
    assert run.saved[-1]["restore_config"] == dns(), "the last persist before the write did not hold the configuration"

    api = FakeAPI(dns())
    api.lose_response = True
    run = Monitor(api)
    with pytest.raises(RuntimeError):
        run.fail(failures_needed())
    assert api.value["preferences"]["overrideLocalDNS"] is False
    assert run.saved[-1]["restore_config"] == dns()


def test_only_a_configuration_the_monitor_disabled_is_restored():
    says("Only a configuration the monitor itself disabled may be restored")
    api = FakeAPI(dns(override=False))
    run = Monitor(api, auto_restore=True)
    run.fail(failures_needed())
    assert api.writes() == 0 and "restore_config" not in run.state, "an override already off is not the monitor's to own"
    run.heal()
    assert api.writes() == 0
    assert api.value["preferences"]["overrideLocalDNS"] is False


def test_auto_restore_is_off_by_default():
    says("**`auto_restore` is off by default**")
    api = FakeAPI(dns())
    run = Monitor(api).disabled_by_the_monitor()
    writes = api.writes()
    run.heal()
    run.tick(True, step=STEP)
    assert api.writes() == writes
    assert api.value["preferences"]["overrideLocalDNS"] is False


def test_restoration_waits_the_stated_healthy_minutes():
    api = FakeAPI(dns())
    run = Monitor(api, auto_restore=True).disabled_by_the_monitor()
    writes = api.writes()
    run.almost_healed()
    assert api.writes() == writes, "the monitor restored before the stated wait"
    run.tick(True, step=1)
    assert api.writes() == writes + 1
    assert api.value == dns()
    assert "restore_config" not in run.state


def test_an_override_someone_else_turned_on_cancels_the_restoration():
    says("It must not restore when the override is already on (someone else did it)", "those cancel the restoration")
    api = FakeAPI(dns())
    run = Monitor(api, auto_restore=True).disabled_by_the_monitor()
    writes = api.writes()
    api.value = dns(override=True)
    run.heal()
    assert api.writes() == writes
    assert "restore_config" not in run.state


def test_a_configuration_edited_apart_from_the_override_cancels_the_restoration():
    says("the live configuration, apart from `overrideLocalDNS`, differs from the saved one (someone edited it)")
    api = FakeAPI(dns())
    run = Monitor(api, auto_restore=True).disabled_by_the_monitor()
    writes = api.writes()
    api.value = dns(override=False, search="edited.test")
    run.heal()
    assert api.writes() == writes
    assert api.value == dns(override=False, search="edited.test")
    assert "restore_config" not in run.state


def test_an_update_is_read_before_and_read_back_after():
    says("the configuration is re-read and must equal what the decision was based on",
         "after it the result is read back and verified")
    api = FakeAPI(dns())
    Monitor(api).fail(failures_needed())
    write = api.events.index("put")
    assert api.events[write - 1] == "get" and api.events[write + 1] == "get"
    assert api.events[:write].count("get") == 2, "the decision read and the re-read are two separate reads"

    api = FakeAPI(dns())
    api.after_first_get = dns(search="edited.test")
    with pytest.raises(RuntimeError):
        Monitor(api).fail(failures_needed())
    assert api.writes() == 0, "the monitor wrote over an edit made after its decision"

    api = FakeAPI(dns())
    api.ignore_write = True
    with pytest.raises(RuntimeError):
        Monitor(api).fail(failures_needed())


def test_the_expected_resolver_is_checked_before_any_change():
    assert stated(r"The expected resolver id is checked before any change \(`(\w+)`\)") == monitor.check_profile.__name__
    other = dns()
    other["nameservers"][0]["address"] = "https://dns.controld.com/profile"
    api = FakeAPI(other)
    with pytest.raises(RuntimeError):
        Monitor(api).fail(failures_needed())
    assert api.writes() == 0, "the monitor edited a tailnet it was not configured for"

    other["preferences"]["overrideLocalDNS"] = False
    api = FakeAPI(other)
    with pytest.raises(RuntimeError):
        Monitor(api, auto_restore=True, state={"restore_config": dns()}).heal()
    assert api.writes() == 0, "the monitor restored a tailnet it was not configured for"


def test_the_named_throttle_limits_api_calls_during_an_outage():
    key = stated(r"`(\w+)` limits API calls during a long outage")
    api = FakeAPI(dns())
    api.ignore_write = True
    run = Monitor(api)
    with pytest.raises(RuntimeError):
        run.fail(failures_needed())
    assert key in run.state
    calls = len(api.events)
    run.tick(False)
    assert len(api.events) == calls, "the monitor called the API again inside the retry window"


@pytest.mark.parametrize("step", [LONG_GAP, -STEP], ids=["long gap", "clock jump"])
def test_a_gap_resets_the_streaks_and_the_retry_throttle(step):
    says("a reboot, a long gap or a clock jump resets the failure and healthy streaks and the retry throttle")
    key = stated(r"`(\w+)` limits API calls during a long outage")
    api = FakeAPI(dns())
    run = Monitor(api)
    run.fail(failures_needed() - 1)
    run.tick(False, step=step)
    assert api.events == [] and run.state["failures"] == 1, "the failure streak survived the gap"

    run = Monitor(FakeAPI(dns()), state={"last_check": 1000, "healthy_since": 1000, key: 10 ** 10})
    run.tick(False, backup_ok=False, step=step)
    assert "healthy_since" not in run.state and key not in run.state

    run = Monitor(FakeAPI(dns()), state={"last_check": 1000, "healthy_since": 1})
    run.tick(True, step=step)
    assert run.state["healthy_since"] == run.now, "the healthy streak survived the gap"


def test_the_config_path_is_the_one_configure_writes():
    written = stated(r"writes the root-only config \(`([^`]+)`\)")
    assert str(monitor.CONFIG) == written
    assert f"path = Path('{written}')" in CONFIGURE


def test_configure_refuses_to_overwrite_and_never_echoes_the_secret():
    says("refuses to overwrite it", "never echoes the secret")
    assert "if path.exists():\n    raise SystemExit(" in CONFIGURE
    assert "os.O_CREAT | os.O_EXCL, 0o600)" in CONFIGURE
    assert "client_secret = getpass.getpass(" in CONFIGURE
    printed = [ast.unparse(n) for n in ast.walk(ast.parse(CONFIGURE)) if isinstance(n, ast.Call)
               and getattr(n.func, "id", "") in ("print", "SystemExit")]
    assert printed and not any("secret" in call or "config" in call for call in printed)


def test_the_monitor_never_prints_the_secret():
    says("`monitor.py` never prints it")
    printed = [ast.unparse(n) for n in ast.walk(MONITOR) if isinstance(n, ast.Call) and getattr(n.func, "id", "") == "print"]
    assert printed
    for call in printed:
        assert "client_secret" not in call and "self.config" not in call
        assert "json.dumps(config" not in call and "print(config" not in call


def test_dry_run_is_stated_as_live_and_reads_the_api():
    says("`--dry-run` is not treated as safe (it calls the live API)",
         "Tests drive `tick()` and the `Client` through fake responses")
    [main] = [n for n in ast.walk(MONITOR) if isinstance(n, ast.FunctionDef) and n.name == "main"]
    [branch] = [n for n in ast.walk(main) if isinstance(n, ast.If) and ast.unparse(n.test) == "args.dry_run"]
    body = "\n".join(ast.unparse(s) for s in branch.body)
    assert "current = client.get()" in body
    assert "client.put" not in body and "tick(" not in body
