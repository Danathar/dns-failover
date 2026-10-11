"""Offline tests for dns-upstream-probe.py: the DoT exchange is replaced by a fake socket stack."""
import struct

import pytest


class FakeConn:
    def __init__(self, reply):
        self.buffer = reply
        self.sent = b""

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def sendall(self, data):
        self.sent += data

    def recv(self, size):
        chunk, self.buffer = self.buffer[:size], self.buffer[size:]
        return chunk


def reply(rcode=0, answers=1):
    body = struct.pack("!6H", 1, 0x8180 | rcode, 1, answers, 0, 0)
    return struct.pack("!H", len(body)) + body


def install(probe, monkeypatch, data, record=None):
    conn = FakeConn(data)

    class Ctx:
        def wrap_socket(self, raw, server_hostname):
            if record is not None:
                record["hostname"] = server_hostname
            return conn

    monkeypatch.setattr(probe.socket, "create_connection", lambda addr, timeout: FakeConn(b""))
    monkeypatch.setattr(probe.ssl, "create_default_context", Ctx)
    return conn


def test_probe_reports_verified_noerror(probe, monkeypatch):
    record = {}
    conn = install(probe, monkeypatch, reply(), record)
    out = probe.probe("192.0.2.1", "dns.example", "example.com")
    assert "NOERROR, answers=1" in out
    assert "TLS verified" in out
    # Certificate name verification uses the supplied hostname.
    assert record["hostname"] == "dns.example"
    length = struct.unpack("!H", conn.sent[:2])[0]
    assert length == len(conn.sent) - 2
    assert b"\x07example\x03com\x00" in conn.sent


@pytest.mark.parametrize(("rcode", "label"), [(2, "SERVFAIL"), (3, "NXDOMAIN"), (5, "REFUSED"), (4, "4")])
def test_probe_names_response_codes(probe, monkeypatch, rcode, label):
    install(probe, monkeypatch, reply(rcode=rcode, answers=0))
    assert f": {label}, answers=0" in probe.probe("192.0.2.1", "dns.example", "example.com")


def test_probe_reports_truncated_response_instead_of_raising(probe, monkeypatch):
    install(probe, monkeypatch, reply()[:5])
    out = probe.probe("192.0.2.1", "dns.example", "example.com")
    assert out.startswith("192.0.2.1 example.com: EOFError")


def test_probe_reports_connection_errors(probe, monkeypatch):
    def refuse(*_a, **_k):
        raise ConnectionRefusedError("refused")

    monkeypatch.setattr(probe.socket, "create_connection", refuse)
    assert probe.probe("192.0.2.1", "dns.example", "example.com") == "192.0.2.1 example.com: ConnectionRefusedError: refused"


def test_recv_exact_assembles_short_reads(probe):
    class Slow:
        def __init__(self):
            self.data = b"abcdef"

        def recv(self, size):
            chunk, self.data = self.data[:2], self.data[2:]
            return chunk

    assert probe.recv_exact(Slow(), 6) == b"abcdef"
