// The lists of "files that bound agents" in docs/agent-boundaries.md and
// docs/security/SECURITY-AI.md are hand copies of risk-config.json's Tier 1
// and Tier 2 paths, minus the product code those tiers also hold. Each copy
// had lost entries the tiers still list (`.github/rulesets/` from the full
// list, `.claude/settings.json`, `.claude/hooks/` and `scripts/check-policies.mjs`
// from the Tier 1 lists) with every check green. These tests hold each copy
// to the tier table, so a path added to a tier has to be added to the lists,
// or named below as not bounding agents, in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const BOUNDARIES = 'docs/agent-boundaries.md';
const SECURITY = 'docs/security/SECURITY-AI.md';
const config = JSON.parse(read('risk-config.json'));

// Tier 1 and Tier 2 paths that are the product, its configuration or the
// licence: owner-reviewed because of what they can break on the DNS host, not
// because they bound what an agent may do.
const NOT_BOUNDING = new Set([
    'install-dns-failover.sh',
    'tailscale-dns-failover/install.sh',
    'tailscale-dns-failover/configure.py',
    'tailscale-dns-failover/monitor.py',
    'dns-upstream-check.py',
    'dns-upstream-probe.py',
    '**/*.service',
    '**/*.timer',
    '**/dnsmasq-*.conf',
    '**/*.conf.example',
    '**/stubby-*.yml',
    '**/stubby-*.yml.example',
    'pyproject.toml',
    'LICENSE',
]);

// A tier path as the pages write it: a directory glob is its directory.
const asWritten = (p) => p.replace(/\/\*\*$/, '/');

function bounding(...tiers) {
    const paths = config.tiers.filter((t) => tiers.includes(t.tier)).flatMap((t) => t.paths);
    return paths.filter((p) => !NOT_BOUNDING.has(p)).map(asWritten).sort();
}

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function section(page, heading) {
    const lines = read(page).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${page} has no ${JSON.stringify(heading)} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The text inside the parentheses that follow `phrase`, newlines folded.
function parenthetical(text, phrase) {
    const flat = text.replace(/\s*\n\s*/g, ' ');
    const at = flat.indexOf(`${phrase} (`);
    assert.notEqual(at, -1, `no "${phrase} (" in the section`);
    const open = at + phrase.length + 1;
    return flat.slice(open + 1, flat.indexOf(')', open));
}

test('every NOT_BOUNDING path is still in Tier 1 or Tier 2', () => {
    const owned = new Set(config.tiers.filter((t) => t.tier <= 2).flatMap((t) => t.paths));
    assert.deepEqual([...NOT_BOUNDING].filter((p) => !owned.has(p)), []);
});

test(`${BOUNDARIES} "Files that bound agents" lists exactly the Tier 1 and Tier 2 files that bound agents`, () => {
    const body = section(BOUNDARIES, '## Files that bound agents');
    const bullets = body.split('\n\n').find((block) => block.startsWith('- '));
    assert.ok(bullets, 'no bullet list in the section');
    assert.deepEqual([...new Set(codeSpans(bullets))].sort(), bounding(1, 2));
});

test(`${BOUNDARIES} Tier 1 row names every Tier 1 file that bounds agents`, () => {
    const row = section(BOUNDARIES, '## By tier').split('\n').find((l) => l.startsWith('| 1 critical |'));
    assert.ok(row, 'no Tier 1 row in the tier table');
    assert.deepEqual(codeSpans(parenthetical(row, 'edit files that bound agents')).sort(), bounding(1));
});

test(`${SECURITY} section 8 names every Tier 1 file that bounds agents`, () => {
    const body = section(SECURITY, '## 8. What agents must never do');
    assert.deepEqual(codeSpans(parenthetical(body, 'relaxes any file that bounds agents')).sort(), bounding(1));
});
