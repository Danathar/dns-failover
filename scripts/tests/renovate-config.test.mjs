import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const config = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'renovate.json'), 'utf8'),
);

test('renovate.json keeps the recommended preset and schema', () => {
    assert.equal(
        config.$schema,
        'https://docs.renovatebot.com/renovate-schema.json',
    );
    assert.ok(config.extends.includes('config:recommended'));
});

test('renovate.json requires dashboard approval for workflow-file updates', () => {
    const rule = (config.packageRules ?? []).find(
        (r) =>
            Array.isArray(r.matchFileNames) &&
            r.matchFileNames.includes('.github/workflows/**'),
    );
    assert.ok(
        rule,
        'a packageRule must match .github/workflows/** (Tier 1 paths need owner approval)',
    );
    assert.equal(rule.dependencyDashboardApproval, true);
    assert.ok(
        typeof rule.description === 'string' && rule.description.length > 0,
        'the rule must say why it exists',
    );
});
