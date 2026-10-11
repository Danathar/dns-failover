#!/usr/bin/env python3
"""Prompt locally for OAuth credentials; never print them or enable automation."""
import getpass
import json
import os
from pathlib import Path
from monitor import Client, resolver_id

path = Path('/root/.config/tailscale-dns-failover/config.json')
if path.exists():
    raise SystemExit(f'{path} already exists; edit it to update settings.')
client_id = input('Tailscale OAuth client ID: ').strip()
client_secret = getpass.getpass('Tailscale OAuth client secret (hidden): ').strip()
if not client_id or not client_secret:
    raise SystemExit('Both credentials are required.')
config = {'tailnet': '-', 'client_id': client_id, 'client_secret': client_secret, 'auto_restore': False}
current = Client(config).get()
profiles = {resolver_id(x['address']) for x in current['nameservers']}
if len(profiles) != 1 or None in profiles:
    raise SystemExit('Expected global nameservers for a single ControlD profile; credentials not saved.')
config['expected_resolver_id'] = profiles.pop()
path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
print(f'Credentials stored in {path} with permissions 0600. Automation is not enabled.')
