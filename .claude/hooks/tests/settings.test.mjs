// Structural checks on .claude/settings.json: it parses, registers the Bash
// guard, pre-approves only the contract commands, asks before Tier 1 edits
// (docs/risk-tiers.md) and denies the commands the host rule forbids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const settings = JSON.parse(readFileSync(`${ROOT}.claude/settings.json`, 'utf8'));
const { allow, ask, deny } = settings.permissions;

test('registers the guard-bash hook for the Bash tool, and the file exists', () => {
    const entry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
    assert.ok(entry, 'no PreToolUse hook for Bash');
    assert.match(entry.hooks[0].command, /\.claude\/hooks\/guard-bash\.mjs/);
    assert.ok(existsSync(`${ROOT}.claude/hooks/guard-bash.mjs`));
});

test('allow rules are the contract commands (node --test only in quoted glob form)', () => {
    for (const rule of [
        'Bash(python3 -m pytest:*)',
        'Bash(ruff check .)',
        'Bash(tests/e2e/run.sh)',
        "Bash(node --test '.claude/hooks/tests/*.test.mjs')",
        "Bash(node --test 'scripts/tests/*.test.mjs')",
        'Bash(node scripts/check-policies.mjs)',
    ]) {
        assert.ok(allow.includes(rule), `${rule} is not allowed`);
    }
    assert.deepEqual(allow.filter((r) => /node --test[^']*\/\)/.test(r)), [], 'directory form of node --test');
    assert.deepEqual(allow.filter((r) => /^Bash\((sudo|systemctl|service|python3 \S*monitor|\S*install)/.test(r)), []);
});

test('Tier 1 paths ask before Edit and Write', () => {
    const tier1 = [
        '.github/workflows/**', '.github/CODEOWNERS', '.github/rulesets/**', '.claude/settings.json', '.claude/hooks/**',
        'policies/**', 'scripts/check-policies.mjs', 'risk-config.json', 'LICENSE', 'AGENTS.md', 'install-dns-failover.sh',
        'tailscale-dns-failover/install.sh', 'tailscale-dns-failover/configure.py', 'tailscale-dns-failover/monitor.py',
        'dns-upstream-check.py', '*.service', '*.timer',
    ];
    for (const path of tier1) {
        for (const tool of ['Edit', 'Write']) assert.ok(ask.includes(`${tool}(${path})`), `${tool}(${path}) does not ask`);
    }
    assert.ok(ask.includes('Bash(git push:*)'));
});

test('deny rules cover force pushes, reset --hard, privilege, systemctl and the installers', () => {
    for (const rule of [
        'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)', 'Bash(git reset --hard:*)',
        'Bash(sudo:*)', 'Bash(systemctl:*)', 'Bash(./install-dns-failover.sh:*)',
        'Bash(bash tailscale-dns-failover/install.sh:*)', 'Bash(python3 tailscale-dns-failover/configure.py:*)',
        'Bash(python3 tailscale-dns-failover/monitor.py:*)',
    ]) {
        assert.ok(deny.includes(rule), `${rule} is not denied`);
    }
});
