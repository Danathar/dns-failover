// The "Signals" table of docs/quality.md names, for each required check, the
// workflow and job it runs in and the commands that job runs. Nothing read the
// table, and its `Lint` row said `ruff check .` while the job has also run
// shellcheck on every tracked shell script; the `policy-check` and
// `agent-tooling` rows left out a step each. These tests hold the rows that
// block merge to the workflows and to .github/rulesets/main.json, so a check
// added to a required job, or a required check renamed, has to be written
// into the table in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/quality.md';

// What a required job checks, read from a command line or from a code span of
// the page with the same patterns. A step of a required job that matches none
// of these has to be named in NOT_A_CHECK.
const CHECKS = [
    ['ruff', /\bruff(?:==[\d.]+)? check\b/g],
    ['shellcheck', /(?<![\w/.$-])shellcheck(?=\s|$)(?! --version)/g],
    ['pytest', /-m pytest\b/g],
    ['coverage run', /-m coverage run\b/g],
    ['coverage report', /-m coverage report\b/g],
    ['e2e', /\btests\/e2e\/[\w.-]+\.sh\b/g],
    ['policies', /\bnode scripts\/check-policies\.mjs\b/g],
    ['settings.json', /\.claude\/settings\.json\b/g],
];
const NODE_TEST = /\bnode --test ((?:'[^']+'|"[^"]+"|[^\s'"]+)(?: (?:'[^']+'|"[^"]+"|[^\s'"]+))*)/g;

// Steps of the required jobs that install tools or publish output.
const NOT_A_CHECK = new Set([
    'Install pinned shellcheck',
    'Install Python and pytest',
    'Install Python, pytest and coverage',
    'Publish table',
]);

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

function checksIn(text) {
    const found = new Set();
    for (const [name, pattern] of CHECKS) {
        if (text.match(pattern)) found.add(name);
    }
    for (const m of text.matchAll(NODE_TEST)) {
        const args = m[1].split(' ').map((a) => a.replace(/^(['"])(.*)\1$/, '$2'));
        found.add(`node --test ${args.join(' ')}`);
    }
    return found;
}

// Jobs of a workflow as { name: [{ step, run }] }. Enough YAML for the files
// here: two-space indents, `name:` per job, `run:` inline or as a block, and a
// `${{ matrix.name }}` job name expanded over `matrix.include`.
function workflowJobs(rel) {
    const lines = read(rel).split('\n');
    const jobs = {};
    const start = lines.indexOf('jobs:');
    assert.notEqual(start, -1, `${rel} has no jobs:`);
    let job = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^\S/.test(line)) break;
        if (/^ {2}[\w-]+:\s*$/.test(line)) {
            job = { name: null, matrix: [], steps: [] };
            jobs[line.trim().slice(0, -1)] = job;
            continue;
        }
        if (!job) continue;
        let m;
        if ((m = /^ {4}name: (.+)$/.exec(line))) job.name = m[1].trim();
        else if ((m = /^ {10}- name: (.+)$/.exec(line))) job.matrix.push(m[1].trim());
        else if ((m = /^ {6}- (?:name: (.+))?/.exec(line))) job.steps.push({ step: m[1]?.trim() ?? null, run: null });
        else if ((m = /^ {8}name: (.+)$/.exec(line))) job.steps.at(-1).step = m[1].trim();
        else if ((m = /^ {8}run: ?(.*)$/.exec(line)) && job.steps.length) {
            let run = m[1];
            if (/^[|>][-+]?$/.test(run)) {
                const body = [];
                while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^ {9,}/.test(lines[i + 1]))) {
                    body.push(lines[++i].trim());
                }
                run = body.join('\n').trim();
            }
            job.steps.at(-1).run = run.replace(/\\\n\s*/g, ' ');
        }
    }
    const byName = {};
    for (const job of Object.values(jobs)) {
        const names = job.name?.includes('${{ matrix.name }}')
            ? job.matrix.map((n) => job.name.replace('${{ matrix.name }}', n))
            : [job.name];
        for (const name of names) byName[name] = job.steps.filter((s) => s.run !== null);
    }
    return byName;
}

function section(heading) {
    const lines = read(PAGE).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${JSON.stringify(heading)} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// A table row's cells, split on `|` outside code spans; `\|` is a literal bar.
function cells(row) {
    const out = [];
    let cell = '';
    let code = false;
    for (let i = 1; i < row.length; i++) {
        const c = row[i];
        if (c === '\\' && row[i + 1] === '|') {
            cell += '|';
            i++;
        } else if (c === '`') {
            code = !code;
            cell += c;
        } else if (c === '|' && !code) {
            out.push(cell.trim());
            cell = '';
        } else cell += c;
    }
    return out;
}

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function signalRows() {
    const rows = section('## Signals').split('\n').filter((l) => l.startsWith('|'));
    const [header, rule, ...body] = rows.map(cells);
    assert.deepEqual(header, ['signal', 'where it lives', 'what it tells you', 'blocks merge']);
    assert.ok(rule.every((c) => /^-+$/.test(c)));
    return body.map(([signal, where, what, blocks]) => {
        const workflow = /\]\(\.\.\/(\.github\/workflows\/[\w.-]+\.yml)\)/.exec(where)?.[1] ?? null;
        const named = /\bjobs? ((?:`[^`]+`(?:, and |, | and )?)+)/.exec(where);
        return { signal, where, what, blocks, workflow, jobs: named ? codeSpans(named[1]) : [] };
    });
}

function requiredChecks() {
    const ruleset = JSON.parse(read('.github/rulesets/main.json'));
    const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
    return rule.parameters.required_status_checks.map((c) => c.context).sort();
}

const required = () => signalRows().filter((r) => /^yes\b/.test(r.blocks));

test('every row that blocks merge names its workflow and jobs, and the jobs exist there', () => {
    const rows = required();
    assert.ok(rows.length > 0, 'no row blocks merge');
    for (const row of rows) {
        assert.ok(row.workflow, `${row.signal}: no workflow link`);
        assert.ok(row.jobs.length > 0, `${row.signal}: names no job`);
        const jobs = workflowJobs(row.workflow);
        for (const job of row.jobs) assert.ok(job in jobs, `${row.signal}: ${row.workflow} has no job ${JSON.stringify(job)}`);
    }
});

test('the jobs of the rows that block merge are exactly the ruleset\'s required checks', () => {
    assert.deepEqual(required().flatMap((r) => r.jobs).sort(), requiredChecks());
});

test('the paragraph under the table names the required checks and how many rows they fill', () => {
    const rows = signalRows();
    const blocking = rows.map((r, i) => (/^yes\b/.test(r.blocks) ? i : -1)).filter((i) => i >= 0);
    const flat = section('## Signals').replace(/\s*\n\s*/g, ' ');
    const m = /The first (\w+) rows are the required checks: (.*?) are what a branch ruleset matches/.exec(flat);
    assert.ok(m, 'no "The first ... rows are the required checks" sentence');
    const count = NUMBER_WORDS.indexOf(m[1].toLowerCase());
    assert.equal(count, blocking.length, `the sentence says ${m[1]}, ${blocking.length} rows block merge`);
    assert.deepEqual(blocking, [...Array(count).keys()], 'the rows that block merge are not the first rows');
    assert.deepEqual(codeSpans(m[2]).sort(), requiredChecks());
});

test('each row that blocks merge names every check its jobs run, and no other', () => {
    for (const row of required()) {
        const jobs = workflowJobs(row.workflow);
        const run = new Set();
        for (const job of row.jobs) {
            for (const step of jobs[job]) {
                const found = new Set(step.run.split('\n').flatMap((l) => [...checksIn(l)]));
                if (found.size === 0) {
                    assert.ok(NOT_A_CHECK.has(step.step), `${job}: step ${JSON.stringify(step.step)} runs no known check; add it to CHECKS or NOT_A_CHECK`);
                }
                for (const c of found) run.add(c);
            }
        }
        const stated = new Set(codeSpans(`${row.where} ${row.what}`).flatMap((s) => [...checksIn(s)]));
        assert.deepEqual([...stated].sort(), [...run].sort(), `${row.signal}: the row and ${row.workflow} disagree`);
    }
});

test('every NOT_A_CHECK step is still a step of a required job', () => {
    const steps = new Set();
    for (const row of required()) {
        const jobs = workflowJobs(row.workflow);
        for (const job of row.jobs) for (const s of jobs[job]) steps.add(s.step);
    }
    assert.deepEqual([...NOT_A_CHECK].filter((s) => !steps.has(s)), []);
});

test('the check patterns read the spellings the page and the workflows use', () => {
    assert.deepEqual([...checksIn("git ls-files -z '*.sh' | xargs -0 shellcheck")], ['shellcheck']);
    assert.deepEqual([...checksIn('shellcheck --version')], []);
    assert.deepEqual([...checksIn('curl -o "$RUNNER_TEMP/shellcheck.tar.xz" .../shellcheck-v0.11.0.tar.xz')], []);
    assert.deepEqual([...checksIn('pipx run ruff==0.16.1 check .')], ['ruff']);
    assert.deepEqual([...checksIn('apt-get install -y python3 python3-pytest python3-coverage')], []);
    assert.deepEqual(
        [...checksIn('python3 -m coverage run -m pytest && python3 -m coverage report')].sort(),
        ['coverage report', 'coverage run', 'pytest'],
    );
    assert.deepEqual([...checksIn("node --test '.claude/hooks/tests/*.test.mjs'")], ['node --test .claude/hooks/tests/*.test.mjs']);
});

test('the workflow reader finds every step that runs something', () => {
    const ci = workflowJobs('.github/workflows/ci.yml');
    assert.deepEqual(Object.keys(ci).sort(), ['E2E (debian container)', 'Lint', 'Unit tests (debian 12)', 'Unit tests (debian 13)']);
    assert.deepEqual(ci.Lint.map((s) => s.step), ['Ruff (pinned)', 'Install pinned shellcheck', 'shellcheck (installers and e2e scripts)']);
    assert.match(ci['Unit tests (debian 13)'].at(-1).run, /^python3 --version\npython3 -m pytest$/);
});
