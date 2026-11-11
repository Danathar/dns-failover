#!/usr/bin/env node
/**
 * Pull-request-time half of the agent audit's `signature` requirement.
 *
 * `scripts/ai-audit-report.mjs` reads merged pull requests weekly and flags an
 * agent PR whose body has no `— hive: agent=...` line; by then the body can no
 * longer be fixed. `.github/workflows/agent-signature.yml` runs this script on
 * an open agent PR instead, so the line can be added before merge.
 *
 * It uses the audit's own `findSignature`, so the two checks cannot disagree
 * about what counts as a signature line (fenced code blocks are skipped the
 * same way).
 *
 * Input: the PR body in the `PR_BODY` environment variable (the workflow sets
 * it through `env:`, never by expanding the body into the script).
 * Exit codes: 0 the body has a signature line; 1 it does not.
 */

import { fileURLToPath } from 'node:url';
import { findSignature } from './ai-audit-report.mjs';

/**
 * Runs the check; returns the exit code. The body is never echoed: it is
 * attacker-editable text and could carry workflow commands.
 */
export function main(env = process.env, stdout = process.stdout, stderr = process.stderr) {
    if (findSignature(env.PR_BODY)) {
        stdout.write('The pull request body has a `— hive: agent=...` signature line.\n');
        return 0;
    }
    stderr.write(
        '::error::The pull request body has no `— hive: agent=<name> ...` signature line ' +
            '(outside code blocks). The weekly agent audit (agent-audit.yml) will flag this ' +
            'PR once merged. Edit the PR description to add the line; this check reruns on edit.\n',
    );
    return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
