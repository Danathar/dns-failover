#!/usr/bin/env python3
"""Send a DNS-over-TLS query with certificate verification to each upstream."""
import argparse
import concurrent.futures
import secrets
import socket
import ssl
import struct
import time


def recv_exact(conn, size):
    data = b""
    while len(data) < size:
        part = conn.recv(size - len(data))
        if not part:
            raise EOFError("upstream closed without a full DNS response")
        data += part
    return data


def probe(ip, hostname, name):
    started = time.monotonic()
    try:
        qname = b"".join(bytes([len(label)]) + label.encode() for label in name.split(".")) + b"\0"
        query = struct.pack("!6H", secrets.randbelow(65536), 0x0100, 1, 0, 0, 1)
        query += qname + struct.pack("!HH", 1, 1)
        query += struct.pack("!BHHIH", 0, 41, 1232, 0x8000, 0)
        with socket.create_connection((ip, 853), timeout=4) as raw:
            with ssl.create_default_context().wrap_socket(raw, server_hostname=hostname) as conn:
                conn.sendall(struct.pack("!H", len(query)) + query)
                size = struct.unpack("!H", recv_exact(conn, 2))[0]
                response = recv_exact(conn, size)
        _, flags, _, answers, _, _ = struct.unpack("!6H", response[:12])
        rcode = {0: "NOERROR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED"}.get(flags & 15, flags & 15)
        return f"{ip} {name}: {rcode}, answers={answers}, {round((time.monotonic()-started)*1000)} ms, TLS verified"
    except Exception as exc:
        return f"{ip} {name}: {type(exc).__name__}: {exc}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--controld-profile", required=True, help="ControlD profile ID to probe")
    args = parser.parse_args()
    if not args.controld_profile.isalnum():
        parser.error("Profile ID must be alphanumeric")
    hostname = args.controld_profile + ".dns.controld.com"
    upstreams = [
        ("76.76.2.22", hostname),
        ("76.76.10.22", hostname),
        ("1.1.1.3", "family.cloudflare-dns.com"),
        ("1.0.0.3", "family.cloudflare-dns.com"),
    ]
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(probe, ip, host, name) for ip, host in upstreams for name in ("example.com", "cloudflare.com")]
        for future in futures:
            print(future.result())
