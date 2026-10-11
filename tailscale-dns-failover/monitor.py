#!/usr/bin/env python3
"""Manage tailnet DNS override during outages of its configured ControlD profile."""
import argparse
import base64
import concurrent.futures
import copy
import ipaddress
import json
import os
import runpy
import secrets
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path('/root/.config/tailscale-dns-failover/config.json')
STATE = Path('/var/lib/tailscale-dns-failover/state.json')
API = 'https://api.tailscale.com/api/v2'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


class Client:
    def __init__(self, config):
        self.config = config
        self.token = None
        tailnet = urllib.parse.quote(config.get('tailnet', '-'), safe='')
        self.url = f'{API}/tailnet/{tailnet}/dns/configuration'

    def request(self, url, data=None, token=None, form=False):
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if data is not None:
            headers['Content-Type'] = 'application/x-www-form-urlencoded' if form else 'application/json'
            data = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode()
        request = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            # Do not print response bodies or authentication data into the journal.
            raise RuntimeError(f'Tailscale API returned HTTP {exc.code}') from None
        except urllib.error.URLError:
            raise RuntimeError('Cannot reach Tailscale API') from None

    def authenticate(self):
        if not self.token:
            response = self.request(API + '/oauth/token', {
                'grant_type': 'client_credentials',
                'client_id': self.config['client_id'],
                'client_secret': self.config['client_secret'],
                'scope': 'dns',
            }, form=True)
            self.token = response['access_token']

    def get(self):
        self.authenticate()
        result = self.request(self.url, token=self.token)
        return normalize(result)

    def put(self, value):
        self.authenticate()
        # The DNS configuration endpoint uses POST to set the complete object.
        self.request(self.url, data=value, token=self.token)


def normalize(value):
    # Current OpenAPI: optional preference booleans default to false. The live
    # API omits false values and empty collections; compare semantic values.
    if not isinstance(value, dict):
        raise RuntimeError('Unexpected DNS configuration schema; no update sent')
    value = copy.deepcopy(value)
    for key, default in (('nameservers', []), ('splitDNS', {}), ('searchPaths', []), ('preferences', {})):
        value.setdefault(key, default)
        if not isinstance(value[key], type(default)):
            raise RuntimeError('Unexpected DNS configuration schema; no update sent')
    prefs = value['preferences']
    for key in ('overrideLocalDNS', 'magicDNS'):
        prefs.setdefault(key, False)
        if type(prefs[key]) is not bool:
            raise RuntimeError('Invalid DNS preference type; no update sent')
    groups = [value['nameservers']] + list(value['splitDNS'].values())
    for group in groups:
        if group is None:
            continue  # The documented splitDNS schema permits null lists.
        if not isinstance(group, list):
            raise RuntimeError('Invalid resolver list; no update sent')
        for resolver in group:
            if not isinstance(resolver, dict) or not isinstance(resolver.get('address'), str):
                raise RuntimeError('Invalid resolver address; no update sent')
            resolver.setdefault('useWithExitNode', False)
            if type(resolver['useWithExitNode']) is not bool:
                raise RuntimeError('Invalid resolver option; no update sent')
    return value


def resolver_id(address):
    parsed = urllib.parse.urlparse(address)
    if parsed.scheme == 'https' and parsed.hostname == 'dns.controld.com':
        candidate = parsed.path.strip('/').split('/')[0]
        return candidate if candidate and all(c in '0123456789abcdefghijklmnopqrstuvwxyz' for c in candidate) else None
    try:
        ip = ipaddress.ip_address(address)
        if ip.version != 6 or not any(ip in ipaddress.ip_network(net) for net in ('2606:1a40::/48', '2606:1a40:1::/48')):
            return None
        # Matches Tailscale's published ControlD ID encoding, bytes 6 through 13.
        number = int.from_bytes(ip.packed[6:14], 'big')
        result = ''
        while number:
            number, digit = divmod(number, 36)
            result = '0123456789abcdefghijklmnopqrstuvwxyz'[digit] + result
        return result or None
    except ValueError:
        return None


def check_profile(current, expected):
    profiles = {resolver_id(x['address']) for x in current['nameservers']}
    if not expected or profiles != {expected}:
        raise RuntimeError('Global DNS no longer matches monitored ControlD profile; no update sent')


def good_dns_answer(response, query_id):
    if len(response) < 12:
        return False
    ident, flags, questions, answers, _, _ = struct.unpack('!6H', response[:12])
    if ident != query_id or not flags & 0x8000 or flags & 0x020f:
        return False
    def skip_name(offset):
        while True:
            length = response[offset]
            offset += 1
            if length & 0xc0 == 0xc0:
                return offset + 1
            if length == 0:
                return offset
            if length > 63:
                raise ValueError('Invalid DNS label')
            offset += length
    try:
        offset = 12
        for _ in range(questions):
            offset = skip_name(offset) + 4
        for _ in range(answers):
            offset = skip_name(offset)
            rrtype, rrclass, _, length = struct.unpack('!HHIH', response[offset:offset+10])
            offset += 10
            data = response[offset:offset+length]
            if len(data) != length:
                return False
            if rrtype == 1 and rrclass == 1 and length == 4 and data != b'\0\0\0\0':
                return True
            offset += length
    except (IndexError, ValueError, struct.error):
        return False
    return False


def profile_healthy(profile):
    if not profile or not all(c in '0123456789abcdefghijklmnopqrstuvwxyz' for c in profile):
        raise RuntimeError('Invalid monitored ControlD profile ID')
    def query(name):
        query_id = secrets.randbelow(65536)
        packet = struct.pack('!6H', query_id, 0x0100, 1, 0, 0, 0)
        packet += b''.join(bytes([len(x)]) + x.encode() for x in name.split('.')) + b'\0'
        packet += struct.pack('!HH', 1, 1)
        encoded = base64.urlsafe_b64encode(packet).decode().rstrip('=')
        request = urllib.request.Request(f'https://dns.controld.com/{profile}?dns={encoded}',
                                         headers={'Accept': 'application/dns-message'})
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return good_dns_answer(response.read(65536), query_id)
        except (OSError, ValueError):
            return False
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        return any(list(pool.map(query, ('example.com', 'cloudflare.com'))))


def without_override(value):
    value = copy.deepcopy(value)
    value['preferences'].pop('overrideLocalDNS', None)
    return value


def update(client, current, enabled):
    # Re-read before changing a complete configuration to catch intervening edits.
    if client.get() != current:
        raise RuntimeError('DNS configuration changed during check; retrying later')
    desired = copy.deepcopy(current)
    desired['preferences']['overrideLocalDNS'] = enabled
    client.put(desired)
    if client.get() != desired:
        raise RuntimeError('DNS update could not be verified; inspect the console')


def tick(config, state, primary_ok, backup_ok, now, client, persist):
    # Reset health streaks after a reboot, long interruption, or clock jump.
    elapsed = now - state.get('last_check', now)
    if elapsed < 0 or elapsed > 90:
        state['failures'] = 0
        state.pop('healthy_since', None)
    state['last_check'] = now
    if primary_ok:
        state['failures'] = 0
        state.setdefault('healthy_since', now)
        should_restore = (config.get('auto_restore', False)
                          and 'restore_config' in state
                          and now - state['healthy_since'] >= 300)
        if not should_restore:
            return
    else:
        state.pop('healthy_since', None)
        state['failures'] = state.get('failures', 0) + 1
        if state['failures'] < 3 or not backup_ok:
            return
    # Limit API retries, including while a sustained outage is in progress.
    if now < state.get('next_api_attempt', 0):
        return
    state['next_api_attempt'] = now + 60
    persist(state)
    current = client.get()
    check_profile(current, config['expected_resolver_id'])
    enabled = current['preferences']['overrideLocalDNS']
    if not primary_ok:
        if enabled:
            # Save restoration ownership before POST, which might succeed even if
            # its response is lost. Only this exact configuration can be restored.
            state['restore_config'] = current
            persist(state)
            update(client, current, False)
            print('ControlD failed three checks; tailnet DNS override disabled', flush=True)
        return
    baseline = state['restore_config']
    if enabled:
        state.pop('restore_config')
        return
    if without_override(current) != without_override(baseline):
        state.pop('restore_config')
        print('DNS configuration changed externally; automatic restoration canceled', flush=True)
        return
    update(client, current, True)
    state.pop('restore_config')
    print('ControlD healthy for five minutes; tailnet DNS override restored', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=CONFIG)
    parser.add_argument('--state', type=Path, default=STATE)
    parser.add_argument('--status', action='store_true', help='Read remote settings without changing them')
    parser.add_argument('--dry-run', action='store_true', help='Probe DNS and read the API; make no changes')
    args = parser.parse_args()
    if args.config.stat().st_mode & 0o077:
        raise RuntimeError('Credential configuration must have permissions 0600')
    config = json.loads(args.config.read_text())
    client = Client(config)
    if args.status:
        print(json.dumps(client.get(), indent=2))
        return
    health = runpy.run_path('/usr/local/sbin/dns-upstream-check')['healthy']
    primary_ok = profile_healthy(config['expected_resolver_id'])
    backup_ok = health(5454) if not primary_ok or args.dry_run else False
    if args.dry_run:
        current = client.get()
        check_profile(current, config['expected_resolver_id'])
        print(json.dumps({'primary_healthy': primary_ok, 'backup_healthy': backup_ok,
                          'monitored_profile': config['expected_resolver_id'],
                          'preferences': current['preferences'],
                          'auto_restore': config.get('auto_restore', False)}, indent=2))
        return
    state = json.loads(args.state.read_text()) if args.state.exists() else {}
    try:
        tick(config, state, primary_ok, backup_ok, time.time(), client,
             lambda value: save(args.state, value))
    finally:
        save(args.state, state)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Messages from our exceptions contain no credential material.
        print(f'tailscale-dns-failover: {type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
