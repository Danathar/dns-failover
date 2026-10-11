# What the follow-up issues on openaudible-autoupdate taught, applied here before starting

**Date:** 2026-10-11
**Context:** the ACMM gap issues on this repository are being worked as parallel
slices, one pull request each. `Danathar/openaudible-autoupdate` went through the
same set of issues first (`Danathar/openaudible-autoupdate#51` to `#59`), and
then Hive agents filed eight follow-up issues against what had merged
(`#60`, `#62`, `#65`, `#67`, `#69`, `#71`, `#73`, `#75`), each fixed by a pull
request (`#63`, `#64`, `#66`, `#68`, `#70`, `#72`, `#74`, `#76`). This is what
those showed, read with `gh issue view` and `gh pr view` on that repository,
and what was done here before writing any code. An earlier reflection on the
tududi rollout (`Danathar/openaudible-autoupdate`,
`docs/reflections/2026-10-09-acmm-lessons-from-tududi.md`) covered the first
round; this one covers the second.

## What happened

- **Pre-approved commands were not safe because of their options.**
  `Danathar/openaudible-autoupdate#60` (high severity): the allow rules for
  `node --test` and `git diff|log|show` match by prefix, and the guard hook had
  no case for either. `node --test --import 'data:text/javascript,...'` ran
  arbitrary JavaScript and `git log --output=FILE` overwrote any file, both
  without a prompt. Fixed by `#64` (merged 2026-10-10T10:25Z): a `checkNode`
  allowlist of test-runner options, refusal of `--output`, `--no-index`,
  `--ext-diff`, risky `-c` keys and `GIT_*`/`NODE_*` variables, and a narrowed
  allow rule.
- **A syntax check that is not one.** `#65` (high): `bash -n +n -c 'cmd'` and
  `bash -n +o noexec ...` run the command, under the `Bash(bash -n:*)` allow
  rule. Fixed by `#66` (merged 2026-10-10T17:46Z): refuse any word beginning
  with `+` (or one bash could expand into it) in a `-n` invocation.
- **Arguments the hook never sees.** `#71` (high): `printf '%s\n'
  --output=/path | xargs git log` and `... | xargs bash -n` get past every
  argument check, because xargs appends the words at run time. The shared
  corpus already listed `xargs-operands` as a known gap. Fixed by `#72` (merged
  2026-10-11T06:03Z): refuse git, node and shells run through xargs.
- **No shared test.** `#67`: the guard had never been run against the fleet's
  shared refusal corpus (`tests/fixtures/gate-refusal-corpus.json`, canonical
  sha256 `8a4bf0f7...cf71`); it refused 4 of the 18 applicable dangerous
  commands. `#68` (merged 2026-10-10T20:52Z) added the corpus test with the 14
  gaps named in `KNOWN_GAPS`, so closing a gap fails the test until it is
  crossed off.
- **Tests that did not notice weakened checks.** `#62` (24 hand-written
  mutations of the updater, several survived all 31 tests, including skipping
  the checksum when the manifest had none; fixed with `#63`) and `#73` (9 of 39
  mutants survived in the shape checks; fixed by `#74`, test-only). Both were
  found by mutation sweeps, not by coverage: line coverage was already 100%.
- **An optional extra changed the exit status.** `#69` (fixed by `#70`): a
  failing journal logger or desktop notification stopped the run or turned a
  successful upgrade into a failure under `set -euo pipefail`.
- **Docs drifted from the code.** `#75` (fixed by `#76`, merged
  2026-10-11T13:14Z): seven references of the form `script.sh:<line>` in three
  docs had gone stale, four pointing at a closing `fi`, a blank line or a
  comment. The fix named the code instead and added a test that fails on a new
  bare line number.
- **Here, before starting.** This repository's hook was ported from the
  final `main` of that repository, not from the first rollout, so `#64`, `#66`,
  `#68` and `#72` are inherited rather than rediscovered. The corpus file is
  byte-identical (sha256 `8a4bf0f7...cf71`, pinned by the test). Of its 29
  rows, 24 apply to this repository's allow rules and 18 of those are refuse
  rows; the gate refuses 5 and `KNOWN_GAPS` names the other 13, so the table is
  a fixed baseline here too. `python3 -m pytest` is allow-listed with a
  prefix rule, so it got the treatment `node --test` needed:
  `PYTEST_OPTIONS` in `.claude/hooks/guard-bash.mjs` is an allowlist, `-p`,
  `--pyargs`, `-c`, `--rootdir`, `-o` and the rest are refused, operands must
  be project paths, and `PYTEST_ADDOPTS`, `PYTEST_PLUGINS`, `PYTHON*` and
  `COVERAGE_*` variables are refused. The host rule's one exemption
  (`dns-upstream-check.py --no-reload` with scratch paths) is defined by
  on-disk checks in `checkUpstreamCheck`, and refuses argparse abbreviations
  (`--no-rel`, `--dir`), which the script would accept. While porting the
  tests, the loop that matches a refusal's expected fragment was found to
  search all of stderr, including the fixed guidance footer that mentions
  `tests/e2e`, `dnsmasq/stubby` and the Tailscale API; here it matches only the
  specific reason, so those fragments can no longer pass vacuously.

## What it shows

- An allow rule by prefix hands every option of that command to the agent. Each
  of `#60`, `#65` and `#71` was the same hole reached by a different spelling
  (an option, a flag cluster, run-time arguments), and each was found by a
  later review, not by the PR that added the rule. [INFERENCE] The rule class
  is "can the hook see every word that reaches the program"; the three fixes
  were each a separate round because each closed one spelling (`#64` options,
  `#66` the `+n` flag, `#72` run-time arguments).
- Line coverage says a line ran, not that a test would fail if it were wrong
  (`#62`, `#73`). Boundary values and "this check is missing" cases only show up
  when someone mutates the check.
- A table-driven refusal test is only as strong as its matcher: a fragment that
  also appears in the shared error footer proves nothing. [INFERENCE] The
  reference tests have the same weakness, since their footer also names
  `tests/e2e`.
- Citing code by line number rots on the next edit (`#75`); a symbol name does
  not.

## What to do next time

- For every command pre-approved by prefix, write down which options and
  environment variables load code, write files or change state, allowlist the
  rest, and test both a refusal and an allowed case for each rule. Ask "which
  class is this bypass in?" before adding a case.
- Make exemptions depend on what exists on disk (a scratch directory that
  resolves inside temp space, a project path that resolves inside the project),
  never on a word an argument can merely contain, and fail closed on options
  the parser would accept as abbreviations.
- Keep the shared corpus byte-identical and list gaps by name; close a gap in
  the hook and remove its name in the same change.
- Judge tests that guard safety by mutation (does the suite fail if the rule is
  weakened?), not by coverage, and keep refusal assertions specific to the
  reason.
- Cite code by function or symbol name in docs, memory and reflections.
