// Pins the Bash guard's shared shell reader by hash.
//
// .claude/hooks/shell-reader.mjs is the part of the PreToolUse Bash guard that
// reads a command line the way the shell would (words, quotes, `$'...'`,
// brace and wildcard names, wrappers, command strings, git option rules, the
// time budget). Several repositories carry this guard; each keeps its own
// policy in guard-bash.mjs, and all of them import the same reader. The
// canonical copy lives in Danathar/akmods (scripts/tests/shell-reader.test.mjs
// there pins the same hash): a reading fix lands there first, with the new
// hash, and is then copied byte-identical into this repository together with
// the hash below. A copy edited here only, or one left behind, fails this test.
//
// The guard's behaviour is tested in guard-bash.test.mjs and by the shared
// refusal corpus (gate-refusal-corpus.test.mjs), next to this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const READER_PATH = `${ROOT}.claude/hooks/shell-reader.mjs`;
const READER_SHA256 = '724a0a3ae217fc86364526d1f94222ee7179d51906b4a94bbc2dea7279b7b95c';

test('the shell reader is the canonical copy', () => {
    assert.equal(createHash('sha256').update(readFileSync(READER_PATH)).digest('hex'), READER_SHA256,
        '.claude/hooks/shell-reader.mjs differs from the pinned copy; a reading fix changes the canonical copy in ' +
            'Danathar/akmods and this hash together, then the file is copied byte-identical to the other repositories');
});

test('the guard reads commands through the shared reader', () => {
    const guard = readFileSync(`${ROOT}.claude/hooks/guard-bash.mjs`, 'utf8');
    assert.match(guard, /from '\.\/shell-reader\.mjs';/);
});

// env's value options hide the command word from the wrapper walk: without
// them `env -S 'git log -p'` or `env -u NAME git log -p` would read the value
// as the command. Other scans can still catch some spellings, so pin the list.
test('env treats -u, -S and --split-string as taking a separate value word', async () => {
    const { WRAPPER_VALUE_OPTS } = await import('../shell-reader.mjs');
    for (const opt of ['-u', '--unset', '-S', '--split-string']) {
        assert.ok(WRAPPER_VALUE_OPTS.env.includes(opt), `env ${opt} must take a value word`);
    }
});
