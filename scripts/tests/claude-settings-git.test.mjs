// The `env` block in .claude/settings.json sets git's safe.bareRepository to
// `explicit` for every command an agent runs. Without it, a bare repository
// committed as ordinary files in a checked-out branch is picked up by the
// pre-approved `git show` and `git log` (`cd dir` then `git show`, or
// `git -C dir show`), and its config can name a program for git to run
// (diff.*.textconv, selected by the bare repository's info/attributes) with no
// permission prompt. The guard hook cannot see that config, so git itself has
// to refuse the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url));
const settingsEnv = JSON.parse(readFileSync(SETTINGS, 'utf8')).env ?? {};

// A clean git environment: no user or system config, no inherited GIT_* overrides.
function baseEnv(home) {
    return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function git(cwd, env, ...args) {
    return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

// Builds a clone whose tree carries a committed bare repository `evil/` with one
// commit, whose diff.x.textconv program writes `marker`. Returns the clone's path.
function plantedClone(dir, marker) {
    const env = baseEnv(dir);
    const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    const src = join(dir, 'src');
    const work = join(dir, 'work');
    const evil = join(src, 'evil');
    assert.equal(git(dir, env, 'init', '-q', src).status, 0);
    assert.equal(git(dir, env, 'init', '-q', work).status, 0);
    writeFileSync(join(work, 'f'), 'one\n');
    assert.equal(git(work, env, 'add', 'f').status, 0);
    assert.equal(git(work, env, ...ident, 'commit', '-qm', 'planted').status, 0);
    assert.equal(git(src, env, 'init', '-q', '--bare', 'evil').status, 0);
    assert.equal(git(work, env, 'push', '-q', evil, 'HEAD:refs/heads/main').status, 0);
    assert.equal(git(evil, env, 'symbolic-ref', 'HEAD', 'refs/heads/main').status, 0);
    mkdirSync(join(evil, 'info'), { recursive: true });
    writeFileSync(join(evil, 'info', 'attributes'), '* diff=x\n');
    assert.equal(git(evil, env, 'config', 'diff.x.textconv', `touch '${marker}'; cat`).status, 0);
    assert.equal(git(src, env, 'add', 'evil').status, 0);
    assert.equal(git(src, env, ...ident, 'commit', '-qm', 'x').status, 0);
    assert.equal(git(dir, env, 'clone', '-q', src, 'victim').status, 0);
    return join(dir, 'victim');
}

test('settings.json sets safe.bareRepository=explicit through GIT_CONFIG_* for agent commands', () => {
    assert.deepEqual(settingsEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.bareRepository',
        GIT_CONFIG_VALUE_0: 'explicit',
    });
});

test('a committed bare repository cannot make a pre-approved git show or git log run a program', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };

    // The planted program does run without the setting, so the check below is real.
    git(join(victim, 'evil'), baseEnv(dir), 'show');
    assert.ok(existsSync(marker), 'precondition: without safe.bareRepository the planted textconv runs');
    rmSync(marker);

    for (const sub of [['show'], ['log', '-p', '-1']]) {
        for (const [cwd, args] of [
            [victim, ['-C', 'evil', ...sub]],
            [join(victim, 'evil'), sub],
        ]) {
            const r = git(cwd, agentEnv, ...args);
            assert.notEqual(r.status, 0, `git ${args.join(' ')} should refuse the bare repository`);
            assert.match(r.stderr, /safe\.bareRepository/);
            assert.ok(!existsSync(marker), `git ${args.join(' ')} ran the planted program`);
        }
    }

    // The checkout's own repository (.git/, not bare) still works with the setting.
    assert.equal(git(victim, agentEnv, 'status', '--short').status, 0);
    assert.equal(git(victim, agentEnv, 'log', '-1', '--format=%s').stdout.trim(), 'x');
});

// safe.bareRepository=explicit allows a bare repository that is named on the
// command line, so the setting alone does not stop `git --git-dir=evil show`
// or `git --bare show` run inside it. The guard hook refuses those options.
test('a named bare repository still runs the program, so the guard hook refuses it', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };
    const hook = fileURLToPath(new URL('../../.claude/hooks/guard-bash.mjs', import.meta.url));

    for (const [cwd, args] of [
        [victim, ['--git-dir=evil', 'log', '-p', '-1']],
        [victim, ['--git-dir', 'evil', 'show']],
        [join(victim, 'evil'), ['--bare', 'show']],
        [join(victim, 'evil'), ['--bare', 'log', '-p', '-1']],
    ]) {
        const command = `git ${args.join(' ')}`;
        git(cwd, agentEnv, ...args);
        assert.ok(existsSync(marker), `${command} no longer runs the program; this test needs a new route`);
        rmSync(marker);

        const r = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
            encoding: 'utf8',
        });
        assert.equal(r.status, 2, `the guard hook should refuse ${command}: ${r.stderr}`);
        assert.match(r.stderr, /--git-dir|--bare/);
    }
});

// git reads `-c` and `--config-env` at the same scope as the GIT_CONFIG_*
// settings env, and the later value wins, so `git -c safe.bareRepository=all`
// switches the protection off for that one command. The guard hook refuses it.
test('a command-line safe.bareRepository override still runs the program, so the guard hook refuses it', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv, SBR: 'all' };
    const hook = fileURLToPath(new URL('../../.claude/hooks/guard-bash.mjs', import.meta.url));

    for (const [cwd, args] of [
        [victim, ['-c', 'safe.bareRepository=all', '-C', 'evil', 'log', '-p', '-1']],
        [victim, ['-c', 'safe.bareRepository=all', '-C', 'evil', 'show']],
        [join(victim, 'evil'), ['-c', 'safe.bareRepository=all', 'show']],
        [victim, ['--config-env=safe.bareRepository=SBR', '-C', 'evil', 'show']],
    ]) {
        const command = `git ${args.join(' ')}`;
        assert.equal(git(cwd, agentEnv, ...args).status, 0, `${command} should succeed past the settings env`);
        assert.ok(existsSync(marker), `${command} no longer runs the program; this test needs a new route`);
        rmSync(marker);

        const r = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
            encoding: 'utf8',
        });
        assert.equal(r.status, 2, `the guard hook should refuse ${command}: ${r.stderr}`);
        assert.match(r.stderr, /safe\.bareRepository/);
    }
});

// The protection lasts only while the GIT_CONFIG_* settings env is set. A
// command that removes it (`unset`, also as `unset ${!GIT_CONFIG@}` or
// `unset $v`, `env -u`) or clears the whole environment before git (`env -i`,
// a lone `-`) puts safe.bareRepository back on its default, and the planted
// program runs again. The guard hook refuses them.
test('removing the GIT_CONFIG_* settings env still runs the program, so the guard hook refuses it', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };
    const hook = fileURLToPath(new URL('../../.claude/hooks/guard-bash.mjs', import.meta.url));

    for (const command of [
        'env -u GIT_CONFIG_COUNT git -C evil log -p -1',
        'env --unset=GIT_CONFIG_COUNT git -C evil show',
        'unset GIT_CONFIG_COUNT; git -C evil log -p -1',
        // ${!GIT_CONFIG@} expands to every set GIT_CONFIG_* name; $v to the name it holds
        'unset ${!GIT_CONFIG@}; git -C evil log -p -1',
        'v=GIT_CONFIG_COUNT; unset $v; git -C evil log -p -1',
        'env -i git -C evil log -p -1',
        'env - git -C evil show',
        'exec -c git -C evil log -p -1',
        'setpriv --reset-env git -C evil log -p -1',
    ]) {
        // Run as the agent's shell would (bash, whose exec has -c), with the settings env in place.
        spawnSync('bash', ['-c', command], { cwd: victim, env: agentEnv, encoding: 'utf8' });
        assert.ok(existsSync(marker), `${command} no longer runs the program; this test needs a new route`);
        rmSync(marker);

        const r = spawnSync(process.execPath, [hook], {
            input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
            encoding: 'utf8',
        });
        assert.equal(r.status, 2, `the guard hook should refuse ${command}: ${r.stderr}`);
        assert.match(r.stderr, /GIT_CONFIG_\* settings env/);
    }
});
