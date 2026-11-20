// .github/labeler.yml and .github/workflows/labeler.yml are read by nothing
// but GitHub, so a one-line edit can break them with every check green:
//   - a path rule that matches no tracked file never fires, and `sync-labels`
//     quietly leaves the pull requests it was meant for unlabelled;
//   - a rule that names `quality`, `testing`, `security`, `hive/*` or `agent/*`
//     would let a pull request award itself a label that automation reads as
//     "an owner approved this";
//   - the labeler runs with a write token, so its trigger must stay
//     `pull_request` and the job must stay skipped for fork pull requests.
// The helpers take the file text so each failure can be reproduced on a damaged
// copy below, which proves the check can fail rather than only pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const CONFIG = read('.github/labeler.yml');
const WORKFLOW = read('.github/workflows/labeler.yml');
const TRACKED = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const FORK_GUARD = 'github.event.pull_request.head.repo.full_name == github.repository';

// The labeler matches with minimatch, dotfiles included: `*` and `?` stop at a
// slash, `**` crosses slashes, and a leading `**/` also matches the root.
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob.startsWith('**/', i)) {
                re += '(?:.*/)?';
                i += 2;
            } else if (glob.startsWith('**', i)) {
                re += '.*';
                i += 1;
            } else {
                re += '[^/]*';
            }
        } else if (ch === '?') {
            re += '[^/]';
        } else {
            re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

// Every glob listed under any-glob-to-any-file / any-glob-to-all-files, in
// either the inline or the list spelling.
function globsOf(configText) {
    const globs = [];
    for (const line of configText.split('\n')) {
        const inline = line.match(/^\s+any-glob-to-(?:any|all)-file:\s+(\S.*)$/);
        if (inline) {
            globs.push(unquote(inline[1]));
            continue;
        }
        const item = line.match(/^\s+-\s+(\S.*)$/);
        if (item && !item[1].trimEnd().endsWith(':')) globs.push(unquote(item[1]));
    }
    return globs;
}

const deadGlobs = (configText, files) =>
    globsOf(configText).filter((glob) => !files.some((f) => globToRegExp(glob).test(f)));

// The labels the configuration applies: its top-level keys.
function labelsOf(configText) {
    return [...configText.matchAll(/^(['"]?)([^\s'"#:][^'":]*)\1:\s*$/gm)].map((m) => m[2]);
}

const RESERVED = new Set(['quality', 'security', 'testing']);
const RESERVED_PREFIXES = ['hive/', 'agent/'];
const reservedLabels = (configText) =>
    labelsOf(configText).filter(
        (name) => RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p)),
    );

// The block under a top-level key such as `on:` or `jobs:`, without its header.
function topBlock(text, key) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l === `${key}:`);
    if (start === -1) return [];
    const block = [];
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line)) break;
        block.push(line);
    }
    return block;
}

const triggersOf = (workflowText) =>
    topBlock(workflowText, 'on')
        .map((l) => l.match(/^ {2}([A-Za-z_]+):/))
        .filter(Boolean)
        .map((m) => m[1]);

// The job-level `if:` of the `label` job, or null when it has none.
function labelJobGuard(workflowText) {
    const jobs = topBlock(workflowText, 'jobs');
    const start = jobs.findIndex((l) => l === '  label:');
    if (start === -1) return null;
    for (const line of jobs.slice(start + 1)) {
        if (/^ {2}\S/.test(line)) break;
        const guard = line.match(/^ {4}if:\s+(\S.*)$/);
        if (guard) return guard[1].trim();
    }
    return null;
}

test('the labeler configuration still lists path globs and labels', () => {
    assert.ok(globsOf(CONFIG).length > 0, 'no glob was extracted from .github/labeler.yml');
    assert.ok(labelsOf(CONFIG).length > 0, 'no label was extracted from .github/labeler.yml');
    assert.ok(TRACKED.length > 0, 'git ls-files listed nothing to match the globs against');
});

test('every path glob in .github/labeler.yml matches a tracked file', () => {
    assert.deepEqual(deadGlobs(CONFIG, TRACKED), []);
});

test('a glob that matches no tracked file is reported', () => {
    const damaged = `${CONFIG}\n'area/dead':\n  - changed-files:\n      - any-glob-to-any-file: 'no/such/dir-zz/**'\n`;
    assert.deepEqual(deadGlobs(damaged, TRACKED), ['no/such/dir-zz/**']);
});

test('glob translation follows minimatch for the constructs the configuration uses', () => {
    assert.ok(globToRegExp('**/*.service').test('stubby-fallback.service'));
    assert.ok(globToRegExp('**/*.service').test('tailscale-dns-failover/a.service'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/README.md'));
    assert.ok(globToRegExp('dnsmasq*.conf*').test('dnsmasq.conf.example'));
    assert.ok(globToRegExp('.github/workflows/**').test('.github/workflows/.hidden.yml'));
    assert.ok(!globToRegExp('.github/labeler.yml').test('xgithub/labeler.yml'));
    assert.ok(globToRegExp('a?c').test('abc'));
    assert.ok(!globToRegExp('a?c').test('a/c'));
});

test('no path rule can award a label that means an owner approved something', () => {
    assert.deepEqual(reservedLabels(CONFIG), []);
});

test('a reserved label added to the configuration is reported', () => {
    for (const name of ['quality', 'security', 'testing', 'hive/in-progress', 'agent/quality']) {
        const damaged = `${CONFIG}\n'${name}':\n  - changed-files:\n      - any-glob-to-any-file: 'docs/**'\n`;
        assert.deepEqual(reservedLabels(damaged), [name]);
    }
    assert.deepEqual(reservedLabels(`${CONFIG}\nquality:\n  - changed-files: []\n`), ['quality']);
});

test('the labeler workflow triggers on pull_request only', () => {
    assert.deepEqual(triggersOf(WORKFLOW), ['pull_request']);
    assert.deepEqual(
        triggersOf(WORKFLOW.replace(/^ {2}pull_request:/m, '  pull_request_target:')),
        ['pull_request_target'],
    );
});

test('the label job is skipped for fork pull requests', () => {
    assert.equal(labelJobGuard(WORKFLOW), FORK_GUARD);
    const withoutGuard = WORKFLOW.replace(/^ {4}if: .*\n/m, '');
    assert.equal(labelJobGuard(withoutGuard), null);
    assert.notEqual(
        labelJobGuard(WORKFLOW.replace(FORK_GUARD, "github.event_name == 'pull_request'")),
        FORK_GUARD,
    );
});
