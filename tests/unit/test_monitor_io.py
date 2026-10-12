"""Offline tests for the I/O edges of tailscale-dns-failover/monitor.py.

tailscale-dns-failover/test_monitor.py covers the decision logic in `tick`
against a fake API. This file covers what surrounds it: the HTTP client and its
error mapping, the OAuth token exchange, the state file writer, schema
rejection in `normalize`, the DoH probe in `profile_healthy`, and `main`'s
`--status`, `--dry-run` and normal modes. `urllib.request.urlopen` is replaced
in every test, so nothing here reaches the network or the Tailscale API.
"""
import base64
import io
import json
import stat
import struct
import sys
import urllib.error

import monitor
import pytest

CONFIG = {
    "client_id": "client-placeholder",
    "client_secret": "<client-secret>",
    "expected_resolver_id": "example",
}


def dns_config(enabled=True):
    return {
        "nameservers": [{"address": "https://dns.controld.com/example", "useWithExitNode": False}],
        "splitDNS": {},
        "searchPaths": [],
        "preferences": {"overrideLocalDNS": enabled, "magicDNS": True},
    }


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def urlopen(monkeypatch):
    """Record every request; answer from a queue of bytes or exceptions."""
    calls = []
    replies = []

    def fake(request, timeout):
        calls.append((request, timeout))
        reply = replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return FakeResponse(reply)

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    fake.calls = calls
    fake.replies = replies
    return fake


# Client.request


def test_request_sends_json_body_and_bearer_token(urlopen):
    urlopen.replies.append(b'{"ok": true}')
    result = monitor.Client({}).request("https://api.example/x", data={"a": False}, token="tok")
    request, timeout = urlopen.calls[0]
    assert result == {"ok": True}
    assert timeout == 10
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer tok"
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data) == {"a": False}


def test_request_form_encodes_and_omits_authorization_without_token(urlopen):
    urlopen.replies.append(b"")
    result = monitor.Client({}).request("https://api.example/x", data={"k": "v w"}, form=True)
    request, _ = urlopen.calls[0]
    assert result is None
    assert request.get_header("Content-type") == "application/x-www-form-urlencoded"
    assert request.data == b"k=v+w"
    assert request.get_header("Authorization") is None


def test_request_get_has_no_body_or_content_type(urlopen):
    urlopen.replies.append(b"{}")
    monitor.Client({}).request("https://api.example/x", token="tok")
    request, _ = urlopen.calls[0]
    assert request.get_method() == "GET"
    assert request.data is None
    assert request.get_header("Content-type") is None


def test_http_error_reports_status_only_never_the_body(urlopen):
    body = io.BytesIO(b'{"message": "<client-secret> leaked"}')
    urlopen.replies.append(urllib.error.HTTPError("https://api.example/x", 401, "Unauthorized", {}, body))
    with pytest.raises(RuntimeError) as info:
        monitor.Client({}).request("https://api.example/x", token="tok")
    assert str(info.value) == "Tailscale API returned HTTP 401"
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__ is True


def test_unreachable_api_is_a_runtime_error(urlopen):
    urlopen.replies.append(urllib.error.URLError("no route"))
    with pytest.raises(RuntimeError, match="^Cannot reach Tailscale API$") as info:
        monitor.Client({}).request("https://api.example/x")
    assert info.value.__suppress_context__ is True


# Client.authenticate, get, put


def test_authenticate_exchanges_client_credentials_once(urlopen):
    urlopen.replies += [b'{"access_token": "tok-1"}', json.dumps(dns_config()).encode(),
                        json.dumps(dns_config()).encode()]
    client = monitor.Client({**CONFIG, "tailnet": "example.com/a b"})
    client.get()
    client.get()
    assert len(urlopen.calls) == 3
    token_request = urlopen.calls[0][0]
    assert token_request.full_url == "https://api.tailscale.com/api/v2/oauth/token"
    assert dict(monitor.urllib.parse.parse_qsl(token_request.data.decode())) == {
        "grant_type": "client_credentials",
        "client_id": "client-placeholder",
        "client_secret": "<client-secret>",
        "scope": "dns",
    }
    for request, _ in urlopen.calls[1:]:
        assert request.full_url == "https://api.tailscale.com/api/v2/tailnet/example.com%2Fa%20b/dns/configuration"
        assert request.get_header("Authorization") == "Bearer tok-1"


def test_get_rejects_unexpected_response_shape(urlopen):
    urlopen.replies += [b'{"access_token": "tok"}', b"[]"]
    with pytest.raises(RuntimeError, match="Unexpected DNS configuration schema"):
        monitor.Client(CONFIG).get()


def test_update_raises_when_readback_differs():
    class DriftingAPI:
        def __init__(self):
            self.value = dns_config()
            self.writes = []

        def get(self):
            return json.loads(json.dumps(self.value))

        def put(self, value):
            self.writes.append(value)  # accepted, but the next read shows something else

    api = DriftingAPI()
    with pytest.raises(RuntimeError, match="could not be verified"):
        monitor.update(api, api.get(), False)
    assert len(api.writes) == 1


# normalize


@pytest.mark.parametrize("value, message", [
    (None, "Unexpected DNS configuration schema"),
    ({"nameservers": {}}, "Unexpected DNS configuration schema"),
    ({"splitDNS": []}, "Unexpected DNS configuration schema"),
    ({"searchPaths": "lan"}, "Unexpected DNS configuration schema"),
    ({"preferences": []}, "Unexpected DNS configuration schema"),
    ({"preferences": {"magicDNS": 1}}, "Invalid DNS preference type"),
    ({"splitDNS": {"lan": {"address": "192.0.2.1"}}}, "Invalid resolver list"),
    ({"nameservers": ["192.0.2.1"]}, "Invalid resolver address"),
    ({"nameservers": [{"address": 1}]}, "Invalid resolver address"),
    ({"nameservers": [{"address": "192.0.2.1", "useWithExitNode": "false"}]}, "Invalid resolver option"),
])
def test_normalize_refuses_malformed_configuration(value, message):
    with pytest.raises(RuntimeError, match=message):
        monitor.normalize(value)


def test_normalize_accepts_null_split_dns_list():
    value = monitor.normalize({"splitDNS": {"lan": None, "corp": [{"address": "192.0.2.1"}]}})
    assert value["splitDNS"]["lan"] is None
    assert value["splitDNS"]["corp"] == [{"address": "192.0.2.1", "useWithExitNode": False}]


# tick: manual re-enable during a pending restore


def test_manual_reenable_cancels_pending_restore_without_writing():
    class API:
        writes = []

        def get(self):
            return dns_config(enabled=True)

        def put(self, value):
            self.writes.append(value)

    state = {"restore_config": dns_config(enabled=False), "healthy_since": 0, "last_check": 290}
    persisted = []
    monitor.tick({"expected_resolver_id": "example", "auto_restore": True}, state,
                 True, False, 300, API(), lambda value: persisted.append(dict(value)))
    assert "restore_config" not in state
    assert API.writes == []
    assert persisted and "restore_config" in persisted[0]


# save


def test_save_writes_root_only_file_atomically(tmp_path):
    target = tmp_path / "state" / "state.json"
    monitor.save(target, {"failures": 2})
    monitor.save(target, {"failures": 0})
    assert json.loads(target.read_text()) == {"failures": 0}
    assert target.read_text().endswith("\n")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
    assert not target.with_suffix(".tmp").exists()


# good_dns_answer: malformed packets


def header(answers=1, flags=0x8180):
    return struct.pack("!6H", 7, flags, 1, answers, 0, 0)


QUESTION = b"\x07example\x03com\0" + struct.pack("!HH", 1, 1)


@pytest.mark.parametrize("packet", [
    # A 64-byte label is invalid even when the rest of the packet is a good A answer.
    header() + b"\x40" + b"x" * 64 + b"\0" + struct.pack("!HH", 1, 1)
    + b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + b"\x01\x02\x03\x04",
    header() + QUESTION + b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + b"\x01\x02",  # truncated rdata
    header() + QUESTION + b"\xc0\x0c" + b"\x00\x01",                      # truncated RR header
    header() + b"\x07exam",                                              # question runs off the end
    header(answers=0) + QUESTION,                                        # no answers
    header() + QUESTION + b"\xc0\x0c" + struct.pack("!HHIH", 28, 1, 60, 16) + b"\x20" * 16,  # AAAA only
    header(flags=0x0180) + QUESTION,                                     # not a response
])
def test_good_dns_answer_rejects_malformed_or_useless_packets(packet):
    assert monitor.good_dns_answer(packet, 7) is False


def test_good_dns_answer_skips_non_a_records_before_an_a_record():
    cname = b"\xc0\x0c" + struct.pack("!HHIH", 5, 1, 60, 2) + b"\xc0\x0c"
    a = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + b"\x01\x02\x03\x04"
    assert monitor.good_dns_answer(header(answers=2) + QUESTION + cname + a, 7) is True


# profile_healthy


def answer_for(request):
    encoded = request.full_url.split("?dns=")[1]
    query = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    query_id = struct.unpack("!H", query[:2])[0]
    question = query[12:]
    return (struct.pack("!6H", query_id, 0x8180, 1, 1, 0, 0) + question
            + b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + b"\x01\x02\x03\x04")


@pytest.mark.parametrize("profile", ["", "Upper", "has-dash", None])
def test_profile_healthy_refuses_invalid_profile_ids(profile, monkeypatch):
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *a, **k: pytest.fail("network used"))
    with pytest.raises(RuntimeError, match="Invalid monitored ControlD profile ID"):
        monitor.profile_healthy(profile)


def test_profile_healthy_queries_both_names_over_doh(monkeypatch):
    seen = []

    def fake(request, timeout):
        seen.append((request, timeout))
        return FakeResponse(answer_for(request))

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    assert monitor.profile_healthy("example") is True
    assert len(seen) == 2
    names = set()
    for request, _ in seen:
        encoded = request.full_url.split("?dns=")[1]
        query = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        names.add(query[12:-4])
    assert names == {b"\x07example\x03com\0", b"\x0acloudflare\x03com\0"}
    for request, timeout in seen:
        assert timeout == 3
        assert request.full_url.startswith("https://dns.controld.com/example?dns=")
        assert "=" not in request.full_url.split("?dns=")[1]
        assert request.get_header("Accept") == "application/dns-message"


def test_profile_healthy_needs_only_one_good_answer(monkeypatch):
    def fake(request, timeout):
        if b"\x0acloudflare" in base64.urlsafe_b64decode(request.full_url.split("?dns=")[1] + "=="):
            raise urllib.error.URLError("down")
        return FakeResponse(answer_for(request))

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    assert monitor.profile_healthy("example") is True


@pytest.mark.parametrize("error", [urllib.error.URLError("down"), TimeoutError(), ValueError("bad")])
def test_profile_healthy_is_false_when_every_query_fails(error, monkeypatch):
    def fake(request, timeout):
        raise error

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    assert monitor.profile_healthy("example") is False


def test_profile_healthy_is_false_on_wrong_query_id(monkeypatch):
    def fake(request, timeout):
        reply = bytearray(answer_for(request))
        reply[0] ^= 0xFF
        return FakeResponse(bytes(reply))

    monkeypatch.setattr(monitor.urllib.request, "urlopen", fake)
    assert monitor.profile_healthy("example") is False


# main


class FakeClient:
    instances = []

    def __init__(self, config):
        self.config = config
        self.value = dns_config()
        self.writes = []
        self.gets = 0
        FakeClient.instances.append(self)

    def get(self):
        self.gets += 1
        return json.loads(json.dumps(self.value))

    def put(self, value):
        self.writes.append(value)
        self.value = value


@pytest.fixture
def run_main(monkeypatch, tmp_path):
    FakeClient.instances = []
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(CONFIG))
    config_path.chmod(0o600)
    state_path = tmp_path / "state" / "state.json"
    probes = {"primary": True, "backup": True, "backup_calls": []}

    def backup(port):
        probes["backup_calls"].append(port)
        return probes["backup"]

    monkeypatch.setattr(monitor, "Client", FakeClient)
    monkeypatch.setattr(monitor, "profile_healthy", lambda profile: probes["primary"])
    monkeypatch.setattr(monitor.runpy, "run_path", lambda path: {"healthy": backup})
    monkeypatch.setattr(monitor.urllib.request, "urlopen", lambda *a, **k: pytest.fail("network used"))

    def run(*args):
        monkeypatch.setattr(sys, "argv", ["monitor.py", "--config", str(config_path), "--state", str(state_path), *args])
        return monitor.main()

    run.config_path = config_path
    run.state_path = state_path
    run.probes = probes
    return run


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o620, 0o601])
def test_main_refuses_config_readable_by_others(run_main, mode):
    run_main.config_path.chmod(mode)
    with pytest.raises(RuntimeError, match="permissions 0600"):
        run_main()
    assert FakeClient.instances == []
    assert not run_main.state_path.exists()


def test_status_prints_remote_config_and_changes_nothing(run_main, capsys):
    run_main("--status")
    assert json.loads(capsys.readouterr().out) == dns_config()
    client, = FakeClient.instances
    assert client.writes == []
    assert run_main.probes["backup_calls"] == []
    assert not run_main.state_path.exists()


def test_dry_run_reports_health_and_never_writes(run_main, capsys):
    run_main.probes["primary"] = False
    run_main.probes["backup"] = True
    run_main("--dry-run")
    report = json.loads(capsys.readouterr().out)
    assert report == {"primary_healthy": False, "backup_healthy": True, "monitored_profile": "example",
                      "preferences": dns_config()["preferences"], "auto_restore": False}
    assert run_main.probes["backup_calls"] == [5454]
    assert FakeClient.instances[0].writes == []
    assert not run_main.state_path.exists()


def test_dry_run_probes_backup_even_when_primary_is_healthy(run_main, capsys):
    run_main.probes["backup"] = False
    run_main("--dry-run")
    report = json.loads(capsys.readouterr().out)
    assert report["primary_healthy"] is True
    assert report["backup_healthy"] is False
    assert run_main.probes["backup_calls"] == [5454]


def test_dry_run_still_checks_the_monitored_profile(run_main):
    run_main.config_path.write_text(json.dumps({**CONFIG, "expected_resolver_id": "other"}))
    with pytest.raises(RuntimeError, match="no longer matches"):
        run_main("--dry-run")


def test_healthy_primary_skips_backup_probe_and_saves_state(run_main):
    run_main()
    assert run_main.probes["backup_calls"] == []
    state = json.loads(run_main.state_path.read_text())
    assert state["failures"] == 0
    assert stat.S_IMODE(run_main.state_path.stat().st_mode) == 0o600


def test_failures_accumulate_across_runs_and_third_disables_override(run_main, monkeypatch, capsys):
    run_main.probes["primary"] = False
    clock = iter([1000.0, 1020.0, 1040.0])
    monkeypatch.setattr(monitor.time, "time", lambda: next(clock))
    run_main()
    run_main()
    assert json.loads(run_main.state_path.read_text())["failures"] == 2
    assert all(c.writes == [] for c in FakeClient.instances)
    run_main()
    assert FakeClient.instances[-1].writes[0]["preferences"]["overrideLocalDNS"] is False
    state = json.loads(run_main.state_path.read_text())
    assert state["restore_config"]["preferences"]["overrideLocalDNS"] is True
    assert "override disabled" in capsys.readouterr().out


def test_restore_ownership_is_on_disk_before_the_post(run_main, monkeypatch):
    # The POST may succeed with its response lost; the state file must already
    # say this monitor owns the restore by the time the request is sent.
    run_main.probes["primary"] = False
    run_main.state_path.parent.mkdir()
    run_main.state_path.write_text(json.dumps({"failures": 2, "last_check": 1000.0}))
    monkeypatch.setattr(monitor.time, "time", lambda: 1020.0)
    on_disk = []
    original_put = FakeClient.put

    def put(self, value):
        on_disk.append(json.loads(run_main.state_path.read_text()))
        original_put(self, value)

    monkeypatch.setattr(FakeClient, "put", put)
    run_main()
    assert on_disk[0]["restore_config"] == dns_config(enabled=True)
    assert on_disk[0]["next_api_attempt"] == 1080.0


def test_state_is_saved_even_when_the_api_fails(run_main, monkeypatch):
    run_main.probes["primary"] = False
    run_main.state_path.parent.mkdir()
    run_main.state_path.write_text(json.dumps({"failures": 2, "last_check": 1000.0}))
    monkeypatch.setattr(monitor.time, "time", lambda: 1020.0)

    def unreachable(self):
        raise RuntimeError("Cannot reach Tailscale API")

    monkeypatch.setattr(FakeClient, "get", unreachable)
    with pytest.raises(RuntimeError, match="Cannot reach"):
        run_main()
    state = json.loads(run_main.state_path.read_text())
    assert state["failures"] == 3
    assert state["next_api_attempt"] == 1080.0
