#!/usr/bin/env node
// Proposes coverage floor raises. Never lowers a floor, never writes the
// repository's pyproject.toml: output goes to --out-dir for the workflow to
// publish as a step summary and a tracking issue.
//
// Reads the floor (`fail_under` under [tool.coverage.report] in pyproject.toml,
// the value `python3 -m coverage report` enforces) and the coverage.py JSON
// report named by `coverage.summary` in .github/auto-qa-tuning.json
// (`totals.percent_covered` is total line+branch coverage in percent).
//
// Usage: node scripts/auto-qa-tuner.mjs [--root <dir>] [--out-dir <dir>]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SECTION = '[tool.coverage.report]';
const FLOOR_LINE = /^(\s*fail_under\s*=\s*)(\d+(?:\.\d+)?)(\s*(?:#.*)?)$/;

/** Total coverage percentage from a coverage.py JSON report, or null when absent. */
export function totalPct(summary) {
    const raw = summary?.totals?.percent_covered;
    const n = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
}

/** Locates fail_under inside [tool.coverage.report]; null when the section or key is missing. */
export function findFloor(toml) {
    const lines = toml.split('\n');
    let inSection = false;
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t.startsWith('[')) {
            inSection = t === SECTION;
            continue;
        }
        if (!inSection) continue;
        const m = FLOOR_LINE.exec(lines[i]);
        if (m) return { index: i, floor: Number(m[2]), lines };
    }
    return null;
}

export function loadSummary(summaryPath, root) {
    const p = resolve(root, summaryPath);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {number} floor current fail_under
 * @param {object} rules .github/auto-qa-tuning.json "coverage" block
 * @param {object|null} summary coverage.py JSON report (null = missing)
 * @returns {{change: object|null, skipped: string[]}}
 */
export function propose(floor, rules, summary) {
    const pct = totalPct(summary);
    if (pct === null) return { change: null, skipped: ['no coverage report, floor left unchanged'] };
    const headroom = round2(pct - floor);
    const target = Math.floor(pct - rules.buffer_below_measured);
    if (headroom > rules.raise_floor_when_headroom_exceeds && target > floor) {
        return { change: { pct, from: floor, to: target, headroom }, skipped: [] };
    }
    return { change: null, skipped: [] };
}

export function renderReport({ change, skipped }, rules) {
    const out = ['## Auto-QA coverage tuning', ''];
    out.push(
        `Rule: raise the floor when measured minus floor exceeds ${rules.raise_floor_when_headroom_exceeds} points, to floor(measured - ${rules.buffer_below_measured}). The floor is never lowered automatically.`,
        ''
    );
    if (change === null) {
        out.push('No floor raise warranted.');
    } else {
        out.push('| measured | floor now | proposed floor |', '| ---: | ---: | ---: |');
        out.push(`| ${change.pct}% | ${change.from}% | ${change.to}% |`);
    }
    for (const s of skipped) out.push('', `Skipped - ${s}`);
    return out.join('\n') + '\n';
}

/** Unified-style diff of the single fail_under line. */
export function floorDiff(found, to) {
    const before = found.lines[found.index];
    const after = before.replace(FLOOR_LINE, (_, pre, _n, post) => `${pre}${to}${post}`);
    return `-${before}\n+${after}`;
}

function main(argv) {
    const arg = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const root = resolve(arg('--root', process.cwd()));
    const outDir = resolve(arg('--out-dir', 'auto-qa-out'));
    const found = findFloor(readFileSync(resolve(root, 'pyproject.toml'), 'utf8'));
    if (!found) {
        process.stderr.write(`pyproject.toml has no fail_under under ${SECTION}\n`);
        process.exit(2);
    }
    const rules = JSON.parse(readFileSync(resolve(root, '.github/auto-qa-tuning.json'), 'utf8')).coverage;
    const result = propose(found.floor, rules, loadSummary(rules.summary, root));
    const report = renderReport(result, rules);
    mkdirSync(outDir, { recursive: true });
    let issueBody = '';
    if (result.change) {
        issueBody =
            report +
            '\nProposed change to `pyproject.toml` (apply by hand in a pull request):\n\n```diff\n' +
            floorDiff(found, result.change.to) +
            '\n```\n';
    }
    writeFileSync(resolve(outDir, 'report.md'), report);
    writeFileSync(resolve(outDir, 'issue-body.md'), issueBody);
    process.stdout.write(report);
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `raise=${result.change !== null}\n`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}
