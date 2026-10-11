import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    classifyAuthor,
    computeMetrics,
    formatDuration,
    median,
    outcomeOf,
    percentile,
    renderMarkdown,
    summarize,
} from '../pr-metrics.mjs';

const NOW = '2026-10-09T12:00:00Z';
const nowMs = Date.parse(NOW);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (ms) => new Date(ms).toISOString();
const human = { login: 'Danathar', is_bot: false };
const hive = { login: 'app/danathar-atomic-hive', is_bot: true };

function merged(number, author, createdAgoMs, openForMs) {
    const created = nowMs - createdAgoMs;
    return {
        number,
        author,
        state: 'MERGED',
        createdAt: iso(created),
        mergedAt: iso(created + openForMs),
        closedAt: iso(created + openForMs),
    };
}

test('no PRs gives zeros and null rates, not NaN', () => {
    const m = computeMetrics([], { now: NOW });
    const all = m.windows.all.overall;
    assert.equal(all.merged, 0);
    assert.equal(all.acceptanceRate, null);
    assert.equal(all.timeToMergeHours.median, null);
    assert.equal(all.timeToMergeHours.p90, null);
    assert.match(renderMarkdown(m), /n\/a/);
});

test('open-only PRs are counted open and leave the rate undefined', () => {
    const prs = [
        { number: 1, author: human, state: 'OPEN', createdAt: iso(nowMs - DAY), mergedAt: null, closedAt: null },
    ];
    const s = computeMetrics(prs, { now: NOW }).windows.all.overall;
    assert.equal(s.open, 1);
    assert.equal(s.merged + s.closedUnmerged, 0);
    assert.equal(s.acceptanceRate, null);
});

test('closed-unmerged PRs lower acceptance and have no merge time', () => {
    const prs = [
        merged(1, human, 3 * DAY, 2 * HOUR),
        {
            number: 2,
            author: human,
            state: 'CLOSED',
            createdAt: iso(nowMs - 3 * DAY),
            mergedAt: null,
            closedAt: iso(nowMs - 2 * DAY),
        },
    ];
    const s = computeMetrics(prs, { now: NOW }).windows.all.overall;
    assert.equal(s.merged, 1);
    assert.equal(s.closedUnmerged, 1);
    assert.equal(s.acceptanceRate, 0.5);
    assert.equal(s.timeToMergeHours.samples, 1);
    assert.equal(s.timeToMergeHours.median, 2);
    assert.equal(outcomeOf(prs[1]), 'closed');
});

test('author classification: owner, Hive app, other bots, other humans', () => {
    assert.equal(classifyAuthor({ login: 'Danathar', is_bot: false }), 'owner');
    assert.equal(classifyAuthor({ login: 'danathar' }), 'owner');
    assert.equal(classifyAuthor(hive), 'hive');
    assert.equal(classifyAuthor({ login: 'danathar-atomic-hive[bot]', is_bot: true }), 'hive');
    assert.equal(classifyAuthor({ login: 'app/dependabot', is_bot: true }), 'other-bot');
    assert.equal(classifyAuthor({ login: 'dependabot[bot]' }), 'other-bot');
    assert.equal(classifyAuthor({ login: 'someone', is_bot: false }), 'other-human');
    assert.equal(classifyAuthor(null), 'other-human');
    // A lookalike account is not Hive.
    assert.equal(classifyAuthor({ login: 'danathar-atomic-hive-fake', is_bot: false }), 'other-human');
});

test('per-class summaries split the same PRs without double counting', () => {
    const prs = [
        merged(1, human, 5 * DAY, HOUR),
        merged(2, hive, 5 * DAY, 3 * HOUR),
        merged(3, { login: 'app/dependabot', is_bot: true }, 5 * DAY, HOUR),
    ];
    const w = computeMetrics(prs, { now: NOW }).windows.all;
    assert.equal(w.overall.merged, 3);
    assert.equal(w.byAuthorClass.owner.merged, 1);
    assert.equal(w.byAuthorClass.hive.merged, 1);
    assert.equal(w.byAuthorClass['other-bot'].merged, 1);
    assert.equal(w.byAuthorClass['other-human'].merged, 0);
    assert.equal(w.byAuthorClass.hive.timeToMergeHours.median, 3);
});

test('window edge: merged exactly 30 days ago is in, one second earlier is out', () => {
    const edge = nowMs - 30 * DAY;
    const on = { ...merged(1, human, 31 * DAY, 0), mergedAt: iso(edge), closedAt: iso(edge) };
    const before = { ...merged(2, human, 31 * DAY, 0), mergedAt: iso(edge - 1000), closedAt: iso(edge - 1000) };
    const m = computeMetrics([on, before], { now: NOW });
    assert.equal(m.windows.all.overall.merged, 2);
    assert.equal(m.windows.last30d.overall.merged, 1);
});

test('window is by merge date, not creation date', () => {
    // Opened 40 days ago, merged yesterday: counts in the 30-day window.
    const pr = merged(1, human, 40 * DAY, 39 * DAY);
    const m = computeMetrics([pr], { now: NOW });
    assert.equal(m.windows.last30d.overall.merged, 1);
    assert.equal(m.windows.last30d.overall.timeToMergeHours.median, 39 * 24);
});

test('PRs decided after "now" are ignored (reproducible with a fixed --now)', () => {
    const pr = merged(1, human, 2 * DAY, 3 * DAY); // merged 1 day in the future
    assert.equal(computeMetrics([pr], { now: NOW }).windows.all.overall.merged, 0);
});

test('custom window length', () => {
    const pr = merged(1, human, 10 * DAY, HOUR);
    const m = computeMetrics([pr], { now: NOW, windowDays: 7 });
    assert.equal(m.windows.last7d.overall.merged, 0);
    assert.equal(m.windows.all.overall.merged, 1);
});

test('median and nearest-rank p90', () => {
    assert.equal(median([]), null);
    assert.equal(median([5]), 5);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    assert.equal(percentile(ten, 90), 9);
    assert.equal(percentile([7], 90), 7);
    assert.equal(percentile([], 90), null);
    const s = summarize(
        ten.map((h, i) => merged(i + 1, human, 20 * DAY, h * HOUR)),
        { nowMs },
    );
    assert.equal(s.timeToMergeHours.median, 5.5);
    assert.equal(s.timeToMergeHours.p90, 9);
});

test('formatDuration picks minutes, hours or days', () => {
    assert.equal(formatDuration(null), 'n/a');
    assert.equal(formatDuration(0.5), '30 min');
    assert.equal(formatDuration(5.25), '5.3 h');
    assert.equal(formatDuration(72), '3 d');
});

test('non-array input is rejected', () => {
    assert.throws(() => computeMetrics({}, { now: NOW }), TypeError);
    assert.throws(() => computeMetrics([], { now: 'not a date' }), TypeError);
});

test('CLI reads stdin and honours --format json', () => {
    const script = fileURLToPath(new URL('../pr-metrics.mjs', import.meta.url));
    const input = JSON.stringify([merged(1, human, 2 * DAY, HOUR)]);
    const out = execFileSync(process.execPath, [script, '--now', NOW, '--format', 'json'], { input, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.totalPrs, 1);
    assert.equal(parsed.windows.all.overall.merged, 1);
});

test('CLI exits non-zero on bad input', () => {
    const script = fileURLToPath(new URL('../pr-metrics.mjs', import.meta.url));
    assert.throws(
        () => execFileSync(process.execPath, [script], { input: '{"not":"an array"}', stdio: 'pipe' }),
        (err) => err.status === 1 && /must be a JSON array/.test(String(err.stderr)),
    );
});
