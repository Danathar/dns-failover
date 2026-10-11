import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { propose, renderReport, floorDiff, findFloor, totalPct, loadSummary } from '../auto-qa-tuner.mjs';

const rules = { summary: 'coverage.json', raise_floor_when_headroom_exceeds: 5, buffer_below_measured: 3 };
// coverage.py writes totals.percent_covered as a number.
const report = (pct) => ({ totals: { percent_covered: pct } });
const PYPROJECT = `[tool.ruff]
line-length = 100

[tool.coverage.run]
fail_under = 1

[tool.coverage.report]
show_missing = true
fail_under = 88  # raised by hand

[tool.other]
fail_under = 2
`;

test('totalPct reads coverage.py totals and rejects anything else', () => {
    assert.equal(totalPct(report(96.4)), 96.4);
    assert.equal(totalPct(report('96.4')), 96.4);
    assert.equal(totalPct(null), null);
    assert.equal(totalPct({}), null);
    assert.equal(totalPct(report('n/a')), null);
    assert.equal(totalPct(report('')), null);
});

test('findFloor only looks inside [tool.coverage.report]', () => {
    const f = findFloor(PYPROJECT);
    assert.equal(f.floor, 88);
    assert.match(f.lines[f.index], /fail_under = 88/);
    assert.equal(findFloor('[tool.coverage.run]\nfail_under = 5\n'), null);
    assert.equal(findFloor('[tool.coverage.report]\nshow_missing = true\n'), null);
});

test('no raise when headroom does not exceed the margin (exactly at margin)', () => {
    assert.equal(propose(88, rules, report(93)).change, null);
});

test('raises to floor(measured - buffer) when headroom exceeds the margin', () => {
    assert.deepEqual(propose(88, rules, report(96.4)).change, { pct: 96.4, from: 88, to: 93, headroom: 8.4 });
});

test('never lowers the floor when coverage drops', () => {
    assert.equal(propose(88, rules, report(40)).change, null);
});

test('a missing report leaves the floor untouched and is reported', () => {
    const r = propose(88, rules, null);
    assert.equal(r.change, null);
    assert.match(r.skipped[0], /no coverage report/);
});

test('the proposed floor is never above measured minus the buffer', () => {
    const { change } = propose(50, rules, report(99.9));
    assert.ok(change.to <= change.pct - rules.buffer_below_measured);
});

test('report and diff show the change and keep the trailing comment', () => {
    const r = propose(88, rules, report(96.4));
    assert.match(renderReport(r, rules), /\| 96\.4% \| 88% \| 93% \|/);
    assert.equal(floorDiff(findFloor(PYPROJECT), 93), '-fail_under = 88  # raised by hand\n+fail_under = 93  # raised by hand');
    assert.match(renderReport({ change: null, skipped: [] }, rules), /No floor raise warranted/);
});

function fixture(pct, pyproject = PYPROJECT) {
    const root = mkdtempSync(join(tmpdir(), 'dnsf-tuner-'));
    mkdirSync(join(root, '.github'));
    writeFileSync(join(root, 'pyproject.toml'), pyproject);
    writeFileSync(join(root, '.github/auto-qa-tuning.json'), JSON.stringify({ coverage: rules }));
    if (pct !== null) writeFileSync(join(root, 'coverage.json'), JSON.stringify(report(pct)));
    return root;
}
const cli = (root, out, outputFile) =>
    spawnSync(process.execPath, [new URL('../auto-qa-tuner.mjs', import.meta.url).pathname, '--root', root, '--out-dir', out], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

test('CLI end to end: writes report and issue body, never touches pyproject.toml', () => {
    const root = fixture(97.5);
    assert.deepEqual(loadSummary('coverage.json', root), report(97.5));
    const before = readFileSync(join(root, 'pyproject.toml'), 'utf8');
    const outputFile = join(root, 'gh-output');
    const run = cli(root, join(root, 'out'), outputFile);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(outputFile, 'utf8'), 'raise=true\n');
    assert.match(readFileSync(join(root, 'out/issue-body.md'), 'utf8'), /```diff\n-fail_under = 88.*\n\+fail_under = 94/);
    assert.equal(readFileSync(join(root, 'pyproject.toml'), 'utf8'), before);
});

test('CLI: no raise writes an empty issue body; missing report is skipped, not an error', () => {
    for (const pct of [90, null]) {
        const root = fixture(pct);
        const outputFile = join(root, 'gh-output');
        const run = cli(root, join(root, 'out'), outputFile);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(readFileSync(outputFile, 'utf8'), 'raise=false\n');
        assert.equal(readFileSync(join(root, 'out/issue-body.md'), 'utf8'), '');
    }
});

test('CLI: a pyproject.toml without a floor fails closed', () => {
    const root = fixture(97.5, '[tool.ruff]\nline-length = 100\n');
    const run = cli(root, join(root, 'out'), join(root, 'gh-output'));
    assert.equal(run.status, 2);
    assert.match(run.stderr, /no fail_under/);
});
