#!/usr/bin/env node
// PR acceptance metrics for Danathar/dns-failover.
//
// Reads the JSON that
//   gh pr list --repo Danathar/dns-failover --state all --limit 500 \
//     --json number,author,state,createdAt,mergedAt,closedAt,labels,title
// prints (from a file or stdin) and reports, per author class and per time
// window: how many PRs were merged, closed without merging, or are still open;
// the acceptance rate; and the time from opened to merged (median and p90).
//
// The script does no network I/O and never writes to GitHub, so the same input
// always gives the same output when --now is fixed. Definitions:
// docs/metrics.md. Node built-ins only.
//
// Usage:
//   node scripts/pr-metrics.mjs --input prs.json [--now 2026-10-09T00:00:00Z]
//        [--window-days 30] [--owner Danathar] [--format markdown|json]
//        [--json-out metrics.json]
//   gh pr list ... | node scripts/pr-metrics.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HIVE_LOGIN = 'danathar-atomic-hive';
export const DEFAULT_OWNER = 'Danathar';
export const DEFAULT_WINDOW_DAYS = 30;
export const AUTHOR_CLASSES = ['owner', 'hive', 'other-bot', 'other-human'];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Login without the `app/` prefix gh adds or the `[bot]` suffix REST adds. */
export function normalizeLogin(login) {
    return String(login ?? '')
        .replace(/^app\//, '')
        .replace(/\[bot\]$/, '');
}

/**
 * owner       the repository owner's own account
 * hive        the Hive GitHub App (danathar-atomic-hive)
 * other-bot   any other app or bot account (dependabot, the Codex connector...)
 * other-human any other non-bot account
 */
export function classifyAuthor(author, owner = DEFAULT_OWNER) {
    const rawLogin = String(author?.login ?? '');
    const login = normalizeLogin(rawLogin);
    if (login === HIVE_LOGIN) return 'hive';
    const isBot =
        author?.is_bot === true ||
        rawLogin.startsWith('app/') ||
        rawLogin.endsWith('[bot]');
    if (isBot) return 'other-bot';
    if (login.toLowerCase() === owner.toLowerCase()) return 'owner';
    return 'other-human';
}

/** merged | closed | open. A PR is "merged" if it has a mergedAt timestamp. */
export function outcomeOf(pr) {
    if (pr.mergedAt) return 'merged';
    if (pr.state === 'CLOSED' || pr.closedAt) return 'closed';
    return 'open';
}

function toMs(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

/** Median of a numeric array; mean of the two middle values when even. */
export function median(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100); no interpolation. */
export function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Summarise a set of PRs.
 *
 * Merged and closed PRs count in the window when they were merged/closed at or
 * after `sinceMs` and at or before `nowMs`. PRs still open are not dated by a
 * decision, so they are counted as open in every window if they were created
 * at or before `nowMs`. `sinceMs = null` means all time.
 */
export function summarize(prs, { sinceMs = null, nowMs }) {
    let merged = 0;
    let closed = 0;
    let open = 0;
    const hoursToMerge = [];
    for (const pr of prs) {
        const outcome = outcomeOf(pr);
        const created = toMs(pr.createdAt);
        if (outcome === 'open') {
            if (created === null || created <= nowMs) open += 1;
            continue;
        }
        const decided = outcome === 'merged' ? toMs(pr.mergedAt) : toMs(pr.closedAt);
        if (decided === null || decided > nowMs) continue;
        if (sinceMs !== null && decided < sinceMs) continue;
        if (outcome === 'closed') {
            closed += 1;
            continue;
        }
        merged += 1;
        if (created !== null && decided >= created) {
            hoursToMerge.push((decided - created) / 3_600_000);
        }
    }
    const decidedCount = merged + closed;
    return {
        merged,
        closedUnmerged: closed,
        open,
        acceptanceRate: decidedCount === 0 ? null : merged / decidedCount,
        timeToMergeHours: {
            samples: hoursToMerge.length,
            median: median(hoursToMerge),
            p90: percentile(hoursToMerge, 90),
        },
    };
}

/**
 * Build the whole report: for each window (all time, last N days) an overall
 * summary plus one per author class.
 */
export function computeMetrics(prs, { now, windowDays = DEFAULT_WINDOW_DAYS, owner = DEFAULT_OWNER } = {}) {
    if (!Array.isArray(prs)) throw new TypeError('PR list must be a JSON array');
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now ?? new Date().toISOString());
    if (Number.isNaN(nowMs)) throw new TypeError('invalid now timestamp');
    const windows = [
        { key: 'all', label: 'all time', sinceMs: null },
        {
            key: `last${windowDays}d`,
            label: `last ${windowDays} days`,
            sinceMs: nowMs - windowDays * DAY_MS,
        },
    ];
    const byClass = Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, []]));
    for (const pr of prs) byClass[classifyAuthor(pr.author, owner)].push(pr);

    const result = {
        generatedAt: new Date(nowMs).toISOString(),
        windowDays,
        totalPrs: prs.length,
        windows: {},
    };
    for (const w of windows) {
        const summary = {
            label: w.label,
            since: w.sinceMs === null ? null : new Date(w.sinceMs).toISOString(),
            overall: summarize(prs, { sinceMs: w.sinceMs, nowMs }),
            byAuthorClass: {},
        };
        for (const c of AUTHOR_CLASSES) {
            summary.byAuthorClass[c] = summarize(byClass[c], { sinceMs: w.sinceMs, nowMs });
        }
        result.windows[w.key] = summary;
    }
    return result;
}

export function formatDuration(hours) {
    if (hours === null || hours === undefined) return 'n/a';
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
    return `${Math.round((hours / 24) * 10) / 10} d`;
}

export function formatRate(summary) {
    if (summary.acceptanceRate === null) return 'n/a';
    const decided = summary.merged + summary.closedUnmerged;
    return `${Math.round(summary.acceptanceRate * 1000) / 10}% (${summary.merged}/${decided})`;
}

const CLASS_LABELS = {
    owner: 'owner',
    hive: 'Hive app',
    'other-bot': 'other bots',
    'other-human': 'other humans',
};

function row(label, s) {
    return `| ${label} | ${s.merged} | ${s.closedUnmerged} | ${s.open} | ${formatRate(s)} | ${formatDuration(s.timeToMergeHours.median)} | ${formatDuration(s.timeToMergeHours.p90)} |`;
}

export function renderMarkdown(metrics) {
    const lines = [
        '# PR metrics',
        '',
        `Generated ${metrics.generatedAt} from ${metrics.totalPrs} PRs. Definitions: docs/metrics.md.`,
        '',
    ];
    for (const w of Object.values(metrics.windows)) {
        lines.push(
            `## ${w.label[0].toUpperCase()}${w.label.slice(1)}`,
            '',
            '| author | merged | closed unmerged | open | acceptance | median to merge | p90 to merge |',
            '|---|---|---|---|---|---|---|',
            row('all', w.overall),
            ...Object.keys(w.byAuthorClass).map((c) => row(CLASS_LABELS[c], w.byAuthorClass[c])),
            '',
        );
    }
    return lines.join('\n');
}

function parseArgs(argv) {
    const opts = { format: 'markdown', windowDays: DEFAULT_WINDOW_DAYS, owner: DEFAULT_OWNER };
    const needValue = (flag, i) => {
        if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--input') opts.input = needValue(a, i++);
        else if (a === '--now') opts.now = needValue(a, i++);
        else if (a === '--window-days') opts.windowDays = Number(needValue(a, i++));
        else if (a === '--owner') opts.owner = needValue(a, i++);
        else if (a === '--format') opts.format = needValue(a, i++);
        else if (a === '--json-out') opts.jsonOut = needValue(a, i++);
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!['markdown', 'json'].includes(opts.format)) throw new Error('--format must be markdown or json');
    if (!Number.isFinite(opts.windowDays) || opts.windowDays <= 0) throw new Error('--window-days must be a positive number');
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const raw = readFileSync(opts.input ?? 0, 'utf8');
    const metrics = computeMetrics(JSON.parse(raw), opts);
    if (opts.jsonOut) writeFileSync(opts.jsonOut, `${JSON.stringify(metrics, null, 2)}\n`);
    process.stdout.write(
        opts.format === 'json' ? `${JSON.stringify(metrics, null, 2)}\n` : `${renderMarkdown(metrics)}\n`,
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        main();
    } catch (err) {
        process.stderr.write(`pr-metrics: ${err.message}\n`);
        process.exit(1);
    }
}
