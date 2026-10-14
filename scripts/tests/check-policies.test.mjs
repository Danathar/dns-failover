import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
    checkAll,
    checkCodeowners,
    checkRiskTiers,
    classify,
    codeownersPattern,
    globToRegExp,
} from '../check-policies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const FORK = read('policies/repo-target.json');
const WORKFLOWS = read('policies/workflow-permissions.json');
const INSTALLER_POLICY = read('policies/installer-safety.json');
const CREDENTIAL_POLICY = read('policies/credential-safety.json');
const CODEOWNERS = read('.github/CODEOWNERS');
const INSTALLER = read('install-dns-failover.sh');
const CONFIGURE = read('tailscale-dns-failover/configure.py');
const MONITOR = read('tailscale-dns-failover/monitor.py');
const SERVICE = read('tailscale-dns-failover/tailscale-dns-failover.service');
const RISK = read('risk-config.json');
const TABLE = `
| Tier | Name | Covers | Required commands | Review |
| ---- | ---- | ------ | ----------------- | ------ |
| 1 | critical | \`backend/migrations/**\`, \`Dockerfile\` | \`npm run lint\`, \`npm run backend:test\` | \`owner\` |
| 2 | low | \`docs/**\` | none | \`ci\` |
`;
const RISK_FIXTURE = {
    default_tier: 2,
    tiers: [
        {
            tier: 1,
            name: 'critical',
            paths: ['backend/migrations/**', 'Dockerfile'],
            required_commands: ['npm run lint', 'npm run backend:test'],
            review: 'owner',
        },
        {
            tier: 2,
            name: 'low',
            paths: ['docs/**'],
            required_commands: [],
            review: 'ci',
        },
    ],
};

/** Build a fixture repo from { relPath: contents } plus the real policies. */
function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-policies-'));
    const all = {
        'policies/repo-target.json': FORK,
        'policies/workflow-permissions.json': WORKFLOWS,
        'policies/installer-safety.json': INSTALLER_POLICY,
        'policies/credential-safety.json': CREDENTIAL_POLICY,
        'install-dns-failover.sh': INSTALLER,
        'tailscale-dns-failover/configure.py': CONFIGURE,
        'tailscale-dns-failover/monitor.py': MONITOR,
        'tailscale-dns-failover/tailscale-dns-failover.service': SERVICE,
        'risk-config.json': RISK,
        'docs/risk-tiers.md': read('docs/risk-tiers.md'),
        '.github/CODEOWNERS': CODEOWNERS,
        ...files,
    };
    for (const [rel, body] of Object.entries(all)) {
        const file = path.join(dir, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
    }
    return dir;
}

function run(files, opts) {
    const dir = fixture(files, opts);
    try {
        return checkAll(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const GOOD_AGENTS =
    'Use `gh pr create --repo Danathar/dns-failover --base main`. See AGENTS.md.\n';
const GOOD_WF = `name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
`;

test('globToRegExp handles **, * and exact names', () => {
    assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
    assert.ok(globToRegExp('**/x.md').test('x.md'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/README.md'));
    assert.ok(!globToRegExp('AGENTS.md').test('AGENTS.mdx'));
    assert.ok(globToRegExp('a.b').test('a.b'));
    assert.ok(!globToRegExp('a.b').test('axb'));
});

test('real repository trees: classify picks the most dangerous tier', () => {
    const config = JSON.parse(RISK);
    assert.equal(classify(config, '.github/workflows/ci.yml').tier, 1);
    assert.equal(classify(config, '.claude/hooks/guard-bash.mjs').tier, 1);
    assert.equal(classify(config, 'LICENSE').tier, 1);
    assert.equal(classify(config, 'AGENTS.md').tier, 1);
    assert.equal(classify(config, 'renovate.json').tier, 1);
    assert.equal(classify(config, 'install-dns-failover.sh').tier, 1);
    assert.equal(classify(config, 'tailscale-dns-failover/monitor.py').tier, 1);
    assert.equal(classify(config, 'dns-upstream-check.py').tier, 1);
    assert.equal(classify(config, 'dns-upstream-probe.py').tier, 2);
    assert.equal(classify(config, 'tailscale-dns-failover/tailscale-dns-failover.timer').tier, 2);
    assert.equal(classify(config, 'dns-upstream-check.service').tier, 2);
    assert.equal(classify(config, 'dnsmasq-wait-online.conf').tier, 2);
    assert.equal(classify(config, 'stubby-primary.yml.example').tier, 2);
    assert.equal(classify(config, 'pyproject.toml').tier, 2);
    assert.equal(classify(config, 'docs/security/SECURITY-AI.md').tier, 2);
    assert.equal(classify(config, '.claude/memory/README.md').tier, 2);
    assert.equal(classify(config, 'README.md').tier, 3);
    assert.equal(classify(config, 'docs/quality.md').tier, 3);
    assert.equal(classify(config, 'tests/unit/test_x.py').tier, 3);
    assert.equal(classify(config, 'scripts/pr-metrics.mjs').tier, 3);
    assert.equal(classify(config, 'scripts/check-policies.mjs').tier, 1);
    assert.equal(classify(config, 'something/unlisted.txt').tier, 3);
});

test('this repository passes its own risk-tier drift check', () => {
    assert.deepEqual(checkRiskTiers(JSON.parse(RISK), read('docs/risk-tiers.md')), []);
});

// ---- repo-target

test('repo-target: compliant tree passes', () => {
    const v = run({ 'AGENTS.md': GOOD_AGENTS, 'docs/notes.md': GOOD_AGENTS });
    assert.deepEqual(v, []);
});

test('repo-target: absent direction files are ignored', () => {
    assert.deepEqual(run({}), []);
});

test('repo-target: direction file without the literal fails', () => {
    const v = run({ '.github/copilot-instructions.md': 'Be nice. AGENTS.md\n' });
    assert.equal(v.length, 1);
    assert.match(v[0], /copilot-instructions\.md.*--repo Danathar\/dns-failover/);
});

test('repo-target: unscoped gh write command fails, with line number', () => {
    const v = run({ 'docs/guide.md': 'x\n\n    gh issue comment 5 --body hi\n' });
    assert.equal(v.length, 1);
    assert.match(v[0], /^docs\/guide\.md:3: "gh issue comment"/);
});

test('repo-target: -R is accepted, GH_REPO alone is not, in markdown', () => {
    assert.deepEqual(run({ 'docs/a.md': 'gh pr merge 3 -R Danathar/dns-failover\n' }), []);
    const v = run({
        'docs/a.md': 'GH_REPO=Danathar/dns-failover gh release create v1\n',
    });
    assert.equal(v.length, 1);
    assert.match(v[0], /docs\/a\.md:1: "gh release create"/);
});

test('repo-target: less common mutating verbs are covered', () => {
    for (const cmd of [
        'gh workflow disable ci.yml',
        'gh workflow enable ci.yml',
        'gh release upload v1 a.zip',
        'gh pr ready 4',
        'gh run rerun 9',
        'gh pr update-branch 4',
    ]) {
        const v = run({ 'docs/a.md': cmd + '\n' });
        assert.equal(v.length, 1, cmd);
    }
});

test('repo-target: flag on a continued line counts, flag on the next command does not', () => {
    const ok = run({
        'docs/a.md':
            '```bash\ngh pr create \\\n  --title t \\\n  --repo Danathar/dns-failover\n```\n',
    });
    assert.deepEqual(ok, []);
    const bad = run({
        'docs/a.md':
            '```bash\ngh pr create --title t\ngh pr list --repo Danathar/dns-failover\n```\n',
    });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /docs\/a\.md:2/);
});

test('repo-target: read-only gh commands and upstream links are allowed', () => {
    const v = run({
        'docs/a.md':
            'gh pr view 3\ngh issue list\nSee https://github.com/octocat/other-repo/issues\n',
    });
    assert.deepEqual(v, []);
});

test('repo-target: targeting octocat/other-repo for a write fails', () => {
    const v = run({
        'docs/a.md': 'gh pr create --repo octocat/other-repo\n',
    });
    assert.ok(v.some((x) => /another repository for a write/.test(x)));
    assert.ok(v.some((x) => /without --repo Danathar\/dns-failover/.test(x)));
});

test('repo-target: markdown outside the scanned dirs is not scanned', () => {
    const v = run({ 'tests/notes.md': 'gh pr create\n' });
    assert.deepEqual(v, []);
});

// ---- workflow-permissions

test('workflows: compliant workflow passes', () => {
    assert.deepEqual(run({ '.github/workflows/a.yml': GOOD_WF }), []);
});

test('workflows: missing top-level permissions fails', () => {
    const wf = GOOD_WF.replace('permissions:\n  contents: read\n', '');
    const v = run({ '.github/workflows/a.yml': wf });
    assert.equal(v.length, 1);
    assert.match(v[0], /a\.yml: no top-level "permissions:"/);
});

test('workflows: job-level permissions alone do not satisfy the rule', () => {
    const wf = GOOD_WF.replace(
        'permissions:\n  contents: read\n',
        '',
    ).replace('    runs-on', '    permissions:\n      contents: read\n    runs-on');
    const v = run({ '.github/workflows/a.yml': wf });
    assert.match(v.join('\n'), /no top-level "permissions:"/);
});

test('workflows: pull_request_target fails, a comment mentioning it does not', () => {
    const bad = run({
        '.github/workflows/a.yml': GOOD_WF.replace('pull_request:', 'pull_request_target:'),
    });
    assert.equal(bad.length, 1);
    assert.match(bad[0], /a\.yml:3: forbidden trigger pull_request_target/);
    const ok = run({
        '.github/workflows/a.yml': `# never use pull_request_target here\n${GOOD_WF}`,
    });
    assert.deepEqual(ok, []);
});

test('workflows: third-party action must be pinned to a 40-hex SHA', () => {
    const sha = 'f87e5991a6d7451dcb8d9637bfbc97413f497069';
    const pinned = GOOD_WF + `      - uses: docker/login-action@${sha} # v4\n`;
    assert.deepEqual(run({ '.github/workflows/a.yml': pinned }), []);

    const tag = GOOD_WF + '      - uses: docker/login-action@v4\n';
    const v = run({ '.github/workflows/a.yml': tag });
    assert.equal(v.length, 1);
    assert.match(v[0], /docker\/login-action must be pinned.*"v4"/);

    const short = GOOD_WF + '      - uses: docker/login-action@f87e599\n';
    assert.equal(run({ '.github/workflows/a.yml': short }).length, 1);

    const noRef = GOOD_WF + '      - uses: some/action\n';
    assert.match(run({ '.github/workflows/a.yml': noRef })[0], /no ref/);
});

test('workflows: actions/, github/, local and docker:// uses need no pin', () => {
    const wf =
        GOOD_WF +
        '      - uses: github/codeql-action/init@v3\n      - uses: ./local\n      - uses: docker://alpine:3\n';
    assert.deepEqual(run({ '.github/workflows/a.yml': wf }), []);
});

const wfWith = (jobs) =>
    `name: x
on:
  pull_request:
permissions:
  contents: read
jobs:
${jobs}`;

test('workflows: gh write command needs a valid GH_REPO or --repo', () => {
    const cmd = GOOD_WF + '      - run: gh issue comment 1 --body hi\n';
    const v = run({ '.github/workflows/a.yml': cmd });
    assert.equal(v.length, 1);
    assert.match(v[0], /a\.yml:\d+: "gh issue comment" has no --repo/);

    const env = 'env:\n  GH_REPO: ${{ github.repository }}\njobs:';
    assert.deepEqual(run({ '.github/workflows/a.yml': cmd.replace('jobs:', env) }), []);
    const lit = GOOD_WF + '      - run: gh pr merge 2 --repo Danathar/dns-failover\n';
    assert.deepEqual(run({ '.github/workflows/a.yml': lit }), []);
});

test('workflows: --repo "$GH_REPO" needs GH_REPO in scope', () => {
    const flag = GOOD_WF + '      - run: gh pr merge 2 --repo "$GH_REPO"\n';
    const v = run({ '.github/workflows/a.yml': flag });
    assert.equal(v.length, 1);
    assert.match(v[0], /uses \$GH_REPO but no valid GH_REPO is set/);
});

test('workflows: GH_REPO or --repo pointing at upstream is rejected', () => {
    const cmd = GOOD_WF + '      - run: gh pr merge 2\n';
    const badEnv = run({
        '.github/workflows/a.yml': cmd.replace('jobs:', 'env:\n  GH_REPO: octocat/other-repo\njobs:'),
    });
    assert.ok(badEnv.some((x) => /GH_REPO is "octocat\/other-repo"/.test(x)));
    assert.ok(badEnv.some((x) => /no --repo and no valid GH_REPO/.test(x)));
    const badFlag = run({
        '.github/workflows/a.yml': GOOD_WF + '      - run: gh pr merge 2 -R octocat/other-repo\n',
    });
    assert.equal(badFlag.length, 1);
    assert.match(badFlag[0], /targets "octocat\/other-repo"/);
});

test('workflows: GH_REPO in another job or step does not scope a write', () => {
    const otherJob = wfWith(`  a:
    runs-on: ubuntu-latest
    env:
      GH_REPO: \${{ github.repository }}
    steps:
      - run: gh pr view 1
  b:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr close 1
`);
    const v = run({ '.github/workflows/a.yml': otherJob });
    assert.equal(v.length, 1);
    assert.match(v[0], /a\.yml:16: "gh pr close" has no --repo/);

    const otherStep = wfWith(`  a:
    runs-on: ubuntu-latest
    steps:
      - name: scoped
        env:
          GH_REPO: \${{ github.repository }}
        run: gh pr close 1
      - name: unscoped
        run: |
          gh pr close 2
`);
    const v2 = run({ '.github/workflows/a.yml': otherStep });
    assert.equal(v2.length, 1);
    assert.match(v2[0], /a\.yml:16: "gh pr close" has no --repo/);
});

test('workflows: step, job and workflow GH_REPO each scope their writes', () => {
    const ok = wfWith(`  a:
    runs-on: ubuntu-latest
    env:
      GH_REPO: Danathar/dns-failover
    steps:
      - run: gh pr close 1
      - name: multi
        run: |
          gh issue comment 1 --body hi
          gh pr merge 2 --repo "$GH_REPO"
  b:
    runs-on: ubuntu-latest
    steps:
      - name: s
        env:
          GH_REPO: \${{ github.repository }}
        run: gh pr close 3
`);
    assert.deepEqual(run({ '.github/workflows/a.yml': ok }), []);
});

test('workflows: an unrelated --repo elsewhere does not scope another write', () => {
    const wf =
        GOOD_WF +
        '      - run: gh pr view 1 --repo Danathar/dns-failover\n      - run: gh pr close 1\n';
    const v = run({ '.github/workflows/a.yml': wf });
    assert.equal(v.length, 1);
    assert.match(v[0], /"gh pr close" has no --repo/);
});

const ALLOWED_TOOLS =
    '      - run: claude --allowedTools "Bash(gh pr create --repo Danathar/dns-failover:*),Bash(gh issue comment --repo Danathar/dns-failover:*),Bash(gh pr merge -R Danathar/dns-failover)"\n';

test('workflows: --allowedTools strings with several scoped gh commands pass', () => {
    assert.deepEqual(run({ '.github/workflows/a.yml': GOOD_WF + ALLOWED_TOOLS }), []);
});

test('workflows: each gh command in one line is judged on its own flag', () => {
    const v = run({
        '.github/workflows/a.yml':
            GOOD_WF +
            '      - run: claude --allowedTools "Bash(gh pr create --repo Danathar/dns-failover:*),Bash(gh issue comment:*)"\n',
    });
    assert.equal(v.length, 1);
    assert.match(v[0], /"gh issue comment" has no --repo/);
});

test('workflows: upstream repo in an --allowedTools string still fails', () => {
    for (const bad of [
        'Bash(gh pr create --repo octocat/other-repo:*)',
        'Bash(gh pr create -R octocat/other-repo)',
        'Bash(gh pr create --repo Danathar/dns-failover-other:*)',
    ]) {
        const v = run({
            '.github/workflows/a.yml': GOOD_WF + `      - run: claude --allowedTools "${bad}"\n`,
        });
        assert.equal(v.length, 1, bad);
        assert.match(v[0], /targets "/);
    }
});

test('repo-target: markdown allowedTools shape passes, upstream and lookalike fail', () => {
    const ok = 'Bash(gh pr create --repo Danathar/dns-failover:*),Bash(gh issue comment --repo Danathar/dns-failover:*)\n';
    assert.deepEqual(run({ 'docs/a.md': ok }), []);
    assert.ok(run({ 'docs/a.md': 'Bash(gh pr create --repo octocat/other-repo:*)\n' }).length > 0);
    assert.ok(run({ 'docs/a.md': 'gh pr create --repo Danathar/dns-failover-fork\n' }).length > 0);
});

test('workflows: command-local GH_REPO overrides are checked', () => {
    const scopedJob = (cmd) =>
        wfWith(`  a:
    runs-on: ubuntu-latest
    env:
      GH_REPO: \${{ github.repository }}
    steps:
      - run: ${cmd}
`);
    for (const bad of [
        'GH_REPO=octocat/other-repo gh pr close 1',
        'env GH_REPO=octocat/other-repo gh issue create',
        'echo hi && GH_REPO="octocat/other-repo" gh pr merge 2',
    ]) {
        const v = run({ '.github/workflows/a.yml': scopedJob(bad) });
        assert.equal(v.length, 1, bad);
        assert.match(v[0], /is preceded by GH_REPO=/);
    }
    assert.deepEqual(
        run({ '.github/workflows/a.yml': scopedJob('GH_REPO=Danathar/dns-failover gh pr close 1') }),
        [],
    );
    // A local value does not leak into the next command after a separator.
    const v = run({
        '.github/workflows/a.yml': wfWith(`  a:
    runs-on: ubuntu-latest
    steps:
      - run: GH_REPO=Danathar/dns-failover gh pr close 1; gh pr close 2
`),
    });
    assert.equal(v.length, 1);
    assert.match(v[0], /"gh pr close" has no --repo/);
});

test('policies cover gh pr revert and gh label clone in markdown and workflows', () => {
    for (const cmd of ['gh pr revert 12', 'gh label clone other/repo']) {
        assert.equal(run({ 'docs/a.md': cmd + '\n' }).length, 1, cmd);
        assert.equal(
            run({ '.github/workflows/a.yml': GOOD_WF + `      - run: ${cmd}\n` }).length,
            1,
            cmd,
        );
    }
    assert.deepEqual(run({ 'docs/a.md': 'gh pr revert 12 --repo Danathar/dns-failover\n' }), []);
});

test('workflows: index-syntax and mixed-case event expressions are rejected', () => {
    for (const expr of [
        "github['event']['issue']['title']",
        'github["event"].issue.title',
        'GitHub.Event.Comment.Body',
        "github['head_ref']",
    ]) {
        const v = run({
            '.github/workflows/a.yml': GOOD_WF + `      - run: echo "\${{ ${expr} }}"\n`,
        });
        assert.equal(v.length, 1, expr);
        assert.match(v[0], /in a run script/);
    }
    const safe = GOOD_WF + "      - run: echo \"${{ github['event']['pull_request']['number'] }}\"\n";
    assert.deepEqual(run({ '.github/workflows/a.yml': safe }), []);
});

test('workflows: top-level write permissions are rejected', () => {
    const all = GOOD_WF.replace('permissions:\n  contents: read', 'permissions: write-all');
    assert.match(run({ '.github/workflows/a.yml': all }).join('\n'), /write-all/);
    const scoped = GOOD_WF.replace('contents: read', 'contents: read\n  issues: write');
    const v = run({ '.github/workflows/a.yml': scoped });
    assert.equal(v.length, 1);
    assert.match(v[0], /a\.yml:6: top-level permissions grant write/);
    const readAll = GOOD_WF.replace('permissions:\n  contents: read', 'permissions: read-all');
    assert.deepEqual(run({ '.github/workflows/a.yml': readAll }), []);
    const empty = GOOD_WF.replace('permissions:\n  contents: read', 'permissions: {}');
    assert.deepEqual(run({ '.github/workflows/a.yml': empty }), []);
});

test('workflows: job-level write permissions are allowed', () => {
    const wf = GOOD_WF.replace('    runs-on', '    permissions:\n      packages: write\n    runs-on');
    assert.deepEqual(run({ '.github/workflows/a.yml': wf }), []);
});

test('workflows: event expressions in run scripts are rejected, env use is not', () => {
    const inline = GOOD_WF + '      - run: echo "${{ github.event.issue.title }}"\n';
    const v = run({ '.github/workflows/a.yml': inline });
    assert.equal(v.length, 1);
    assert.match(v[0], /a\.yml:11:.*github\.event\.issue\.title.*env:/);

    const block = GOOD_WF + '      - name: n\n        run: |\n          echo ok\n          echo "${{ github.head_ref }}"\n';
    const vb = run({ '.github/workflows/a.yml': block });
    assert.equal(vb.length, 1);
    assert.match(vb[0], /a\.yml:14:/);

    const viaEnv =
        GOOD_WF +
        '      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run: echo "$TITLE"\n';
    assert.deepEqual(run({ '.github/workflows/a.yml': viaEnv }), []);

    const safe = GOOD_WF + '      - run: echo "${{ github.event.pull_request.number }} ${{ github.sha }}"\n';
    assert.deepEqual(run({ '.github/workflows/a.yml': safe }), []);
});

// ---- risk tiers

test('risk tiers: matching table and JSON pass', () => {
    assert.deepEqual(checkRiskTiers(RISK_FIXTURE, TABLE), []);
    assert.deepEqual(run({}, { risk: true }), []);
});

test('risk tiers: a path only in the JSON is reported', () => {
    const cfg = structuredClone(RISK_FIXTURE);
    cfg.tiers[0].paths.push('LICENSE');
    const v = checkRiskTiers(cfg, TABLE);
    assert.equal(v.length, 1);
    assert.match(v[0], /tier 1 paths: "LICENSE" is in risk-config\.json but not in the table/);
});

test('risk tiers: a path only in the doc is reported', () => {
    const v = checkRiskTiers(
        RISK_FIXTURE,
        TABLE.replace('`Dockerfile`', '`Dockerfile`, `LICENSE`'),
    );
    assert.equal(v.length, 1);
    assert.match(v[0], /"LICENSE" is in the table but not in risk-config\.json/);
});

test('risk tiers: name, review and command drift are reported', () => {
    const cfg = structuredClone(RISK_FIXTURE);
    cfg.tiers[0].name = 'severe';
    cfg.tiers[0].review = 'ci';
    cfg.tiers[0].required_commands = ['npm run lint'];
    const v = checkRiskTiers(cfg, TABLE).join('\n');
    assert.match(v, /named "critical"/);
    assert.match(v, /review is "owner"/);
    assert.match(v, /"npm run backend:test" is in the table but not in risk-config\.json/);
});

test('risk tiers: tier missing from the table, and extra tier in the table', () => {
    const cfg = structuredClone(RISK_FIXTURE);
    cfg.tiers.push({
        tier: 3,
        name: 'extra',
        paths: [],
        required_commands: [],
        review: 'ci',
    });
    assert.match(checkRiskTiers(cfg, TABLE).join('\n'), /tier 3 \(extra\) is in risk-config\.json but not in the table/);
    const extraRow = TABLE + '| 5 | odd | `x/**` | none | `ci` |\n';
    assert.match(checkRiskTiers(RISK_FIXTURE, extraRow).join('\n'), /tier 5 is in the table but not in risk-config\.json/);
});

test('risk tiers: default_tier must exist and rows need five columns', () => {
    const cfg = structuredClone(RISK_FIXTURE);
    cfg.default_tier = 9;
    assert.match(checkRiskTiers(cfg, TABLE).join('\n'), /default_tier 9/);
    const v = checkRiskTiers(RISK_FIXTURE, TABLE + '| 3 | short | `a` |\n');
    assert.match(v.join('\n'), /malformed tier row/);
});

test('missing policy files are violations', () => {
    const dir = fixture({});
    fs.rmSync(path.join(dir, 'policies'), { recursive: true });
    fs.rmSync(path.join(dir, 'risk-config.json'));
    fs.rmSync(path.join(dir, '.github/CODEOWNERS'));
    try {
        const v = checkAll(dir).join('\n');
        assert.match(v, /policies\/repo-target\.json: missing/);
        assert.match(v, /policies\/workflow-permissions\.json: missing/);
        assert.match(v, /policies\/installer-safety\.json: missing/);
        assert.match(v, /policies\/credential-safety\.json: missing/);
        assert.match(v, /risk-config\.json: missing/);
        assert.match(v, /\.github\/CODEOWNERS: missing/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- CLI

test('cli: exits 1 with violations and 0 when clean; --classify prints tiers', () => {
    const script = path.join(repoRoot, 'scripts', 'check-policies.mjs');
    const bad = fixture({ 'docs/a.md': 'gh pr create\n' });
    const good = fixture({ 'docs/a.md': GOOD_AGENTS });
    try {
        const r1 = spawnSync('node', [script, '--root', bad], { encoding: 'utf8' });
        assert.equal(r1.status, 1);
        assert.match(r1.stderr, /docs\/a\.md:1/);
        const r2 = spawnSync('node', [script, '--root', good], { encoding: 'utf8' });
        assert.equal(r2.status, 0, r2.stderr);
        const r3 = spawnSync(
            'node',
            [script, '--root', good, '--classify', 'LICENSE', 'docs/a.md'],
            { encoding: 'utf8' },
        );
        assert.equal(r3.status, 0);
        assert.match(r3.stdout, /LICENSE: tier 1 \(critical\), review: owner/);
        assert.match(r3.stdout, /docs\/a\.md: tier 3 \(standard\)/);
    } finally {
        fs.rmSync(bad, { recursive: true, force: true });
        fs.rmSync(good, { recursive: true, force: true });
    }
});

// ---- repo-target: other repositories

test('repo-target: GH_REPO and set-default for another repo fail', () => {
    assert.ok(run({ 'docs/a.md': 'export GH_REPO=octocat/other-repo\n' }).length > 0);
    assert.ok(run({ 'docs/a.md': 'gh repo set-default octocat/other-repo\n' }).length > 0);
    assert.deepEqual(run({ 'docs/a.md': 'gh repo set-default Danathar/dns-failover\n' }), []);
});

test('repo-target: read-only gh on another repo is allowed', () => {
    assert.deepEqual(run({ 'docs/a.md': 'gh pr view 3 --repo octocat/other-repo\n' }), []);
});

test('repo-target: write naming both repos still fails', () => {
    const v = run({
        'docs/a.md': 'gh pr create --repo octocat/other-repo --repo Danathar/dns-failover\n',
    });
    assert.ok(v.some((x) => /another repository for a write/.test(x)));
});

test('real repository: all policies pass on this tree', () => {
    assert.deepEqual(checkAll(repoRoot), []);
});


// ---- installer-safety (install-dns-failover.sh)

/** Run the policies on a tree where `file` has `from` replaced by `to`. */
function mutated(file, from, to) {
    const real = read(file);
    assert.ok(real.includes(from), `${file} no longer contains ${JSON.stringify(from)}`);
    return run({ [file]: real.replace(from, to) });
}
const INSTALL_CONFIG = 'install -m 0644 "$config" /etc/dnsmasq.conf';
const RESTORE = 'install -m 0644 "$backup" /etc/dnsmasq.conf';

test('installer-safety: the real installer passes', () => {
    assert.deepEqual(run({}), []);
});

test('installer-safety: missing installer is a violation, not a pass', () => {
    const dir = fixture({});
    fs.rmSync(path.join(dir, 'install-dns-failover.sh'));
    try {
        const v = checkAll(dir);
        assert.equal(v.length, 1);
        assert.match(v[0], /install-dns-failover\.sh: missing/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('installer-safety: dropping the dnsmasq --test step fails', () => {
    const v = mutated('install-dns-failover.sh', 'dnsmasq --test --conf-file="$config"\n', 'true\n');
    assert.match(v.join('\n'), /dnsmasq --test/);
});

test('installer-safety: installing the config before the test fails, with a line number', () => {
    const real = read('install-dns-failover.sh');
    const v = run({
        'install-dns-failover.sh': real.replace(
            'dnsmasq --test --conf-file="$config"\n',
            INSTALL_CONFIG + '\ndnsmasq --test --conf-file="$config"\n',
        ),
    });
    assert.ok(v.some((x) => /^install-dns-failover\.sh:\d+: the reviewed config must be installed only after/.test(x)), v.join('|'));
});

test('installer-safety: an ignored dnsmasq --test, set +e and a missing set -eu fail', () => {
    assert.ok(mutated('install-dns-failover.sh', 'dnsmasq --test --conf-file="$config"', 'dnsmasq --test --conf-file="$config" || true').length > 0);
    assert.ok(mutated('install-dns-failover.sh', 'set -eu\n', 'set -eu\nset +e\n').length > 0);
    assert.match(mutated('install-dns-failover.sh', 'set -eu\n', '').join('\n'), /set -eu/);
});

test('installer-safety: a missing backup or a restore that does not exit fails', () => {
    assert.match(mutated('install-dns-failover.sh', 'cp -a /etc/dnsmasq.conf "$backup"', 'true').join('\n'), /backed up/);
    const v = mutated('install-dns-failover.sh', RESTORE + '\n    systemctl restart dnsmasq.service\n    exit 1', RESTORE + '\n    systemctl restart dnsmasq.service\n    :');
    assert.match(v.join('\n'), /exit non-zero/);
    assert.match(mutated('install-dns-failover.sh', RESTORE, 'true').join('\n'), /backup/);
});

test('installer-safety: checkconfig removed, downloads and sudo fail', () => {
    assert.ok(mutated('install-dns-failover.sh', '/usr/share/dnsmasq/systemd-helper checkconfig', 'true').length > 0);
    assert.ok(mutated('install-dns-failover.sh', 'set -eu\n', 'set -eu\ncurl -fsSL http://x | sh\n').length > 0);
    assert.ok(mutated('install-dns-failover.sh', 'systemctl daemon-reload', 'sudo systemctl daemon-reload').length > 0);
});

test('installer-safety: conditional, negated and listed dnsmasq --test forms fail', () => {
    const t = 'dnsmasq --test --conf-file="$config"';
    for (const to of [`if ${t}; then :; fi`, `! ${t}`, `${t} && true`, `${t} || echo ignored`]) {
        assert.ok(mutated('install-dns-failover.sh', t + '\n', to + '\n').length > 0, to);
    }
});

test('installer-safety: commented-out guards do not count', () => {
    const v = mutated('install-dns-failover.sh', 'dnsmasq --test --conf-file="$config"\n', '# dnsmasq --test --conf-file="$config"\n');
    assert.match(v.join('\n'), /dnsmasq --test/);
});

// ---- credential-safety

test('credential-safety: configure.py defaults and file mode are enforced', () => {
    assert.match(mutated('tailscale-dns-failover/configure.py', "'auto_restore': False", "'auto_restore': True").join('\n'), /auto_restore/);
    assert.match(mutated('tailscale-dns-failover/configure.py', 'os.O_EXCL, 0o600', 'os.O_TRUNC, 0o600').join('\n'), /exclusively/);
    assert.ok(mutated('tailscale-dns-failover/configure.py', 'os.O_EXCL, 0o600', 'os.O_EXCL, 0o644').length > 0);
    assert.ok(mutated('tailscale-dns-failover/configure.py', 'mode=0o700', 'mode=0o755').length > 0);
    assert.match(mutated('tailscale-dns-failover/configure.py', 'if path.exists():', 'if False:').join('\n'), /overwrite/);
    assert.match(mutated('tailscale-dns-failover/configure.py', "print(f'Credentials", "print(client_secret, f'Credentials").join('\n'), /printed/);
    assert.match(mutated('tailscale-dns-failover/configure.py', 'getpass.getpass(', 'input(').join('\n'), /without echo/);
});

test('credential-safety: monitor.py must default auto_restore to false', () => {
    assert.match(mutated('tailscale-dns-failover/monitor.py', "config.get('auto_restore', False)", "config.get('auto_restore', True)").join('\n'), /auto_restore/);
});

test('credential-safety: the service keeps UMask and StateDirectoryMode', () => {
    assert.match(mutated('tailscale-dns-failover/tailscale-dns-failover.service', 'UMask=0077', 'UMask=0022').join('\n'), /UMask=0077/);
    assert.match(mutated('tailscale-dns-failover/tailscale-dns-failover.service', 'StateDirectoryMode=0700', 'StateDirectoryMode=0755').join('\n'), /0700/);
});

test('credential-safety: missing monitored file is a violation', () => {
    const dir = fixture({});
    fs.rmSync(path.join(dir, 'tailscale-dns-failover/configure.py'));
    try {
        assert.match(checkAll(dir).join('\n'), /configure\.py: missing/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// Secret-shaped fixtures are built at run time so this file stays clean.
const fake = (...parts) => parts.join('');

test('secret scan: credential-shaped strings fail, without echoing the value', () => {
    const cases = [
        fake('tskey-', 'client-', 'k1234567890abcdef'),
        fake('gh', 'p_', 'a'.repeat(36)),
        fake('github', '_pat_', 'A1'.repeat(20)),
        fake('sk', '-ant-', 'x'.repeat(40)),
        fake('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
        fake('-----BEGIN ', 'PRIVATE KEY-----'),
        '{"client_secret": "' + 'z'.repeat(24) + '"}',
    ];
    for (const body of cases) {
        const v = run({ 'notes.txt': body + '\n' });
        assert.equal(v.length, 1, body);
        assert.match(v[0], /^notes\.txt:1: credential-shaped string/);
        assert.ok(!v[0].includes(body), 'the matched text must not be echoed');
    }
});

test('secret scan: placeholders and prose pass', () => {
    const ok = [
        'client_secret: <your secret>',
        '{"client_secret": "YOUR_CLIENT_SECRET_GOES_HERE"}',
        'OAuth keys start with tskey-client- and are shown once.',
        'tls_auth_name: "YOUR_CONTROLD_PROFILE_ID.dns.controld.com"',
        "https://dns.controld.com/{profile}?dns={q}",
        "'https://dns.controld.com/example'",
        'host = args.controld_profile + ".dns.controld.com"',
    ];
    assert.deepEqual(run({ 'notes.txt': ok.join('\n') + '\n' }), []);
});

test('secret scan: a real-looking ControlD profile ID fails in both spellings', () => {
    const id = fake('abc1234', 'xyz');
    for (const body of [`tls_auth_name: "${id}.dns.controld.com"`, `https://dns.controld.com/${id}?dns=q`]) {
        const v = run({ 'stubby-primary.yml': body + '\n' });
        assert.equal(v.length, 1, body);
        assert.match(v[0], /^stubby-primary\.yml:1: ControlD profile ID/);
        assert.ok(!v[0].includes(id));
    }
});

test('secret scan: binary files are skipped', () => {
    const dir = fixture({});
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.concat([Buffer.from([0]), Buffer.from(fake('gh', 'p_', 'a'.repeat(36)))]));
    try {
        assert.deepEqual(checkAll(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- CODEOWNERS

test('codeowners: directory and any-depth globs map to the entries CODEOWNERS uses', () => {
    assert.equal(codeownersPattern('policies/**'), '/policies/');
    assert.equal(codeownersPattern('.claude/hooks/**'), '/.claude/hooks/');
    assert.equal(codeownersPattern('LICENSE'), '/LICENSE');
    assert.equal(codeownersPattern('**/*.service'), '*.service');
    assert.equal(codeownersPattern('**/stubby-*.yml.example'), 'stubby-*.yml.example');
});

test('codeowners: every owner-review path of this repository is listed', () => {
    const config = JSON.parse(RISK);
    assert.deepEqual(checkCodeowners(config, CODEOWNERS, config.owner), []);
});

test('codeowners: a dropped entry, a wrong owner and a missing default fail', () => {
    const config = JSON.parse(RISK);
    const without = (line) => CODEOWNERS.split('\n').filter((l) => !l.startsWith(line)).join('\n');
    assert.match(checkCodeowners(config, without('/policies/'), '@Danathar').join('\n'), /"policies\/\*\*" needs an entry "\/policies\/ @Danathar"/);
    assert.match(checkCodeowners(config, without('*.service'), '@Danathar').join('\n'), /\*\.service/);
    assert.match(checkCodeowners(config, CODEOWNERS.replace('/LICENSE ', '/LICENSE @someone-else # '), '@Danathar').join('\n'), /LICENSE/);
    assert.match(checkCodeowners(config, without('* @Danathar'), '@Danathar').join('\n'), /"\*" must default/);
});

test('codeowners: checkAll reports a drop in a real tree and a bad owner field', () => {
    const v = run({ '.github/CODEOWNERS': CODEOWNERS.replace(/^\/docs\/security\/.*$/m, '') });
    assert.ok(v.some((x) => /docs\/security\/\*\*/.test(x)), v.join('|'));
    const cfg = { ...JSON.parse(RISK), owner: 'Danathar' };
    assert.ok(run({ 'risk-config.json': JSON.stringify(cfg) }).some((x) => /"owner" must be/.test(x)));
});

test('risk tiers: a pipe in a command is escaped in the table and compared unescaped', () => {
    const cfg = structuredClone(RISK_FIXTURE);
    cfg.tiers[0].required_commands.push("git ls-files '*.sh' | xargs shellcheck");
    const row = TABLE.replace('`npm run backend:test`', "`npm run backend:test`, `git ls-files '*.sh' \\| xargs shellcheck`");
    assert.deepEqual(checkRiskTiers(cfg, row), []);
    assert.match(checkRiskTiers(cfg, TABLE).join('\n'), /xargs shellcheck/);
});

test('run expressions: a " # " inside a quoted run scalar does not hide an event expression', () => {
    const wf = GOOD_WF + '      - run: "echo # ${{ github.event.issue.title }}"\n';
    assert.match(run({ '.github/workflows/a.yml': wf }).join('\n'), /github\.event\.issue\.title/);
});

test('repo-target: one --repo does not cover a second gh write on the same line', () => {
    const ok = 'gh pr create --repo Danathar/dns-failover && gh pr merge 3 --repo Danathar/dns-failover\n';
    assert.deepEqual(run({ 'docs/a.md': ok }), []);
    const v = run({ 'docs/a.md': 'gh pr create --repo Danathar/dns-failover && gh pr merge 3\n' });
    assert.ok(v.some((x) => /"gh pr merge" without/.test(x)), v.join('|'));
});
