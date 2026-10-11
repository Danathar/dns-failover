import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    auditPr,
    buildReport,
    classify,
    findSignature,
    hasLinkedIssue,
    main,
    parseArgs,
    renderMarkdown,
} from '../ai-audit-report.mjs';

const SIG = '— hive: agent=docs-writer backend=claude model=opus';

function pr(overrides = {}) {
    return {
        number: 1,
        title: 'docs: something',
        author: { login: 'app/danathar-atomic-hive', is_bot: true },
        body: `Closes #5\n\nBody.\n\n${SIG}`,
        mergedAt: '2026-10-05T10:00:00Z',
        mergedBy: { login: 'Danathar', is_bot: false },
        labels: [],
        url: 'https://github.com/Danathar/dns-failover/pull/1',
        baseRefName: 'main',
        closingIssuesReferences: [
            { number: 5, repository: { name: 'dns-failover', owner: { login: 'Danathar' } } },
        ],
        ...overrides,
    };
}

test('a clean agent PR has no violations', () => {
    assert.deepEqual(auditPr(pr()), []);
});

test('bot author is detected in both gh and REST spellings', () => {
    assert.equal(classify(pr()).reason, 'app-author');
    const rest = pr({ author: { login: 'danathar-atomic-hive[bot]' }, body: '' });
    assert.equal(classify(rest).reason, 'app-author');
});

test('other bots are not agents without a signature', () => {
    const dependabot = pr({
        author: { login: 'app/dependabot', is_bot: true },
        body: 'Bumps x',
    });
    assert.equal(classify(dependabot).agent, false);
});

test('signature-only PR from a human account is classified as agent', () => {
    const p = pr({ author: { login: 'Danathar', is_bot: false } });
    assert.deepEqual(classify(p), { agent: true, reason: 'signature' });
    assert.deepEqual(auditPr(p), []);
});

test('signature must be its own line and name an agent', () => {
    assert.equal(findSignature(`text ${SIG}`), null);
    assert.equal(findSignature('— hive: backend=claude'), null);
    assert.equal(findSignature(`a\r\n${SIG}\r\n`), SIG);
});

test('a signature inside a fenced code block is an example, not a signature', () => {
    assert.equal(findSignature(`Example:\n\`\`\`\n${SIG}\n\`\`\`\n`), null);
    assert.equal(findSignature(`~~~\n${SIG}\n~~~\n${SIG}`), SIG);
    const human = pr({
        author: { login: 'Danathar' },
        body: `Docs about the format:\n\`\`\`\n${SIG}\n\`\`\``,
    });
    assert.equal(classify(human).agent, false);
});

test('a longer fence is not closed by a shorter inner fence', () => {
    const body = `\`\`\`\`md\n\`\`\`\n${SIG}\n\`\`\`\n\`\`\`\``;
    assert.equal(findSignature(body), null);
    // closed properly, a later signature counts again
    assert.equal(findSignature(`${body}\n${SIG}`), SIG);
    // different fence character does not close
    assert.equal(findSignature(`\`\`\`\n~~~\n${SIG}`), null);
});

test('missing linked issue is a violation', () => {
    assert.deepEqual(auditPr(pr({ closingIssuesReferences: [] })), ['linked-issue']);
});

test('body text never counts as a linked issue, nor does a missing field', () => {
    for (const body of ['Closes #12', 'Closes #999999', '```\nCloses #3\n```']) {
        assert.equal(hasLinkedIssue({ body: `${body}\n${SIG}` }), false);
    }
    const p = pr({ body: `Closes #5\n${SIG}` });
    delete p.closingIssuesReferences;
    assert.deepEqual(auditPr(p), ['linked-issue']);
});

test('only resolved references in this repository count', () => {
    const ref = (owner, name) => ({
        number: 5,
        repository: { name, owner: { login: owner } },
    });
    const body = `Closes #999999\n${SIG}`;
    // Body text alone does not count when GitHub reports no resolved issue.
    assert.deepEqual(
        auditPr(pr({ body, closingIssuesReferences: [] })),
        ['linked-issue']
    );
    // An issue of another repository does not count.
    assert.deepEqual(
        auditPr(pr({ closingIssuesReferences: [ref('chrisvel', 'dns-failover')] })),
        ['linked-issue']
    );
    assert.deepEqual(
        auditPr(pr({ closingIssuesReferences: [ref('Danathar', 'dns-failover')] })),
        []
    );
});

test('bot-authored PR without signature line violates signature', () => {
    assert.deepEqual(auditPr(pr({ body: 'Closes #5' })), ['signature']);
});

test('a merge by the Hive App is the allowed Hive lane, in either login spelling', () => {
    for (const login of ['app/danathar-atomic-hive', 'danathar-atomic-hive[bot]']) {
        assert.deepEqual(auditPr(pr({ mergedBy: { login } })), []);
        assert.deepEqual(
            auditPr(pr({ author: { login }, mergedBy: { login } })),
            []
        );
    }
});

test('any other bot merger or an unknown merger is a violation', () => {
    assert.deepEqual(auditPr(pr({ mergedBy: null })), ['human-merge']);
    assert.deepEqual(auditPr(pr({ mergedBy: {} })), ['human-merge']);
    assert.deepEqual(
        auditPr(pr({ mergedBy: { login: 'x', is_bot: true } })),
        ['human-merge']
    );
    assert.deepEqual(
        auditPr(pr({ mergedBy: { login: 'dependabot[bot]' } })),
        ['human-merge']
    );
    assert.deepEqual(
        auditPr(pr({ mergedBy: { login: 'app/some-other-app' } })),
        ['human-merge']
    );
});

test('the report counts Hive-lane merges separately and marks the row', () => {
    const r = buildReport([
        pr({ number: 1 }),
        pr({ number: 2, mergedBy: { login: 'app/danathar-atomic-hive' } }),
    ]);
    assert.equal(r.hiveLane, 1);
    assert.equal(r.violationCount, 0);
    const md = renderMarkdown(r);
    assert.match(md, /app\/danathar-atomic-hive \(Hive lane\)/);
    assert.match(md, /1 of 2 audited agent PR\(s\) were merged by the Hive lane/);
});

test('base must be main of this repository', () => {
    assert.deepEqual(auditPr(pr({ baseRefName: 'release' })), ['base']);
    assert.deepEqual(auditPr(pr({ baseRefName: undefined })), ['base']);
    assert.deepEqual(
        auditPr(pr({ url: 'https://github.com/chrisvel/dns-failover/pull/1' })),
        ['base']
    );
});

test('zero agent PRs is reported loudly and counted, not a silent pass', () => {
    const human = pr({
        author: { login: 'Danathar' },
        body: 'Closes #1',
    });
    const report = buildReport([human, human]);
    assert.equal(report.agent, 0);
    assert.equal(report.nonAgent, 2);
    const md = renderMarkdown(report);
    assert.match(md, /nothing was audited/);
    assert.match(md, /2 classified as non-agent/);
    assert.equal(md.includes('| PR |'), false);
});

test('--since filters by merge date and counts only the window', () => {
    const old = pr({ number: 2, mergedAt: '2026-09-01T00:00:00Z' });
    const report = buildReport([pr(), old], { since: '2026-10-01' });
    assert.equal(report.total, 1);
    assert.equal(report.agent, 1);
});

test('report table shows violations and counts', () => {
    const bad = pr({
        number: 7,
        body: 'no signature',
        closingIssuesReferences: [],
        author: { login: 'app/danathar-atomic-hive' },
    });
    const report = buildReport([pr(), bad]);
    assert.equal(report.violationCount, 1);
    const md = renderMarkdown(report);
    assert.match(md, /violates: linked-issue, signature/);
    assert.match(md, /1 of 2 audited agent PR\(s\) violate/);
});

test('pipes in titles do not break the table', () => {
    const md = renderMarkdown(buildReport([pr({ title: 'a | b' })]));
    assert.match(md, /a \\\| b/);
});

function run(argv, input) {
    let written = null;
    const code = main(
        argv,
        () => (typeof input === 'string' ? input : JSON.stringify(input)),
        (_path, content) => {
            written = content;
        }
    );
    return { code, written };
}

test('exit code: non-strict never fails on violations, strict does', () => {
    const bad = [pr({ mergedBy: { login: 'some-other-app[bot]', is_bot: true } })];
    assert.equal(run(['--output', 'x.md'], bad).code, 0);
    assert.equal(run(['--output', 'x.md', '--strict'], bad).code, 1);
    assert.equal(run(['--output', 'x.md', '--strict'], [pr()]).code, 0);
});

test('exit code: zero agent PRs is not a violation, even in strict mode', () => {
    const none = [pr({ author: { login: 'Danathar' }, body: 'x' })];
    assert.equal(run(['--output', 'x.md', '--strict'], none).code, 0);
});

test('exit code 2 for bad input, bad flags and truncated lists', () => {
    assert.equal(run(['--output', 'x.md'], 'not json').code, 2);
    assert.equal(run(['--output', 'x.md'], { a: 1 }).code, 2);
    assert.equal(run(['--bogus'], []).code, 2);
    assert.equal(run(['--limit', '1', '--output', 'x.md'], [pr()]).code, 2);
    for (const bad of ['2026-13-45', '2026-02-30', '2026-02-29', '2026-1-5']) {
        assert.throws(() => parseArgs(['--since', bad]), /real date/);
    }
    assert.equal(parseArgs(['--since', '2028-02-29']).since, '2028-02-29');
});
