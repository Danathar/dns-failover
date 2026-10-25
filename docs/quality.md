# Quality dashboard

Which quality signals this repository has, where to look at each, and how to
read them. There is no hosted dashboard: the signals are GitHub Actions runs
and committed files, and this page is the index. Actions for this repository
are at <https://github.com/Danathar/dns-failover/actions>. Every `gh` command
below names the repository so it works from any clone.

This page lists the signals the ACMM rollout adds, and several of them arrive
in separate pull requests. Until every rollout PR has merged, some links below
point at files that are not on `main` yet; the table says which pull request
owns each one. It deliberately copies no run counts, coverage percentages or
ruleset ids, so nothing here can go stale: read the live value with the
commands under "Where to look".

## Signals

| signal | where it lives | what it tells you | blocks merge |
|---|---|---|---|
| CI jobs | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (workflow `CI`): jobs `Lint`, `Unit tests (debian 12)`, `Unit tests (debian 13)`, `E2E (debian container)` | `ruff check .`, the Python unit tests (`python3 -m pytest`, which includes the offline `tailscale-dns-failover/test_monitor.py`) on Debian 12 (Python 3.11) and Debian 13, and the end-to-end test in a throwaway container (`tests/e2e/run.sh`) | yes, all four |
| coverage gate | [`.github/workflows/coverage-gate.yml`](../.github/workflows/coverage-gate.yml) (job `Coverage gate`), floor in `[tool.coverage.report] fail_under` of [`pyproject.toml`](../pyproject.toml) | line coverage of the product code under the unit tests has not dropped below the floor (`python3 -m coverage run -m pytest && python3 -m coverage report`) | yes |
| policy check | [`.github/workflows/policy-check.yml`](../.github/workflows/policy-check.yml) (job `policy-check`), `scripts/check-policies.mjs`, [`policies/`](../policies) | the repository still satisfies its machine-checkable policies: workflow permissions, `--repo` on every documented `gh` write, and the other rules in `policies/`; `node scripts/check-policies.mjs` runs it locally | yes |
| agent tooling | [`.github/workflows/agent-tooling.yml`](../.github/workflows/agent-tooling.yml) (job `agent-tooling`) | `node --test '.claude/hooks/tests/*.test.mjs'` and `node --test 'scripts/tests/*.test.mjs'`: the command-gate hook (including the host rule) still refuses what it must, and the repo-meta scripts still behave | yes |
| PR metrics | [`.github/workflows/pr-metrics.yml`](../.github/workflows/pr-metrics.yml), definitions in [metrics.md](metrics.md), readings in [metrics/](metrics/README.md) | acceptance rate and time to merge, by author class | no, report only |
| auto-QA | `.github/workflows/auto-qa.yml`, rules in `.github/auto-qa-tuning.json` | weekly: when the coverage floor can be raised, one issue with the proposed diff; it never pushes and never lowers the floor | no, report only |
| agent audit | `.github/workflows/agent-audit.yml`, `scripts/ai-audit-report.mjs` | weekly: each merged agent PR has a linked issue, the signature line and an acceptable merger | no, scheduled |
| nightly compliance | `.github/workflows/nightly-compliance.yml` | every night against `main`: the test suites and the container e2e test again, plus a check that the live branch ruleset matches `.github/rulesets/main.json`; a scheduled failure opens or updates one tracking issue | no, notification |
| mutation check on changed lines | `scripts/mutation-check.mjs`, [`stryker.config.mjs`](../stryker.config.mjs), [`.mutation-survivors.json`](../.mutation-survivors.json); see [below](#mutation-check-on-changed-lines) | a changed line of the guard hook, its reader or a `scripts/*.mjs` script can be broken without any test failing | no, advisory |

The first four rows are the required checks: the job display names (`Lint`,
`Unit tests (debian 12)`, `Unit tests (debian 13)`,
`E2E (debian container)`, `Coverage gate`, `policy-check`, `agent-tooling`)
are what a branch ruleset matches, so they are not renamed. Which ones the
ruleset on `main` currently requires is read from GitHub, not from this page:

```bash
gh api repos/Danathar/dns-failover/rulesets
```

Codex review (`chatgpt-codex-connector[bot]`) may comment on a PR with
`P0`-`P3` findings ([review-rubric.md](review-rubric.md)); it is advisory and
not guaranteed to be available.

## Mutation check on changed lines

Every guard-hook fix that merged here was later found, by a hand mutation audit, to have changed lines the
tests did not notice when they were broken (#73, #114, #127, and the row comments on #131), and each needed
separate test rows. The reader is also copied byte-identical from other repositories, so an unpinned line
here is unpinned everywhere. `scripts/mutation-check.mjs` does that audit for the lines a pull request
changes (#134).

- **What it mutates:** only the added and changed lines (`git diff -U0 <base>...HEAD`) of
  `.claude/hooks/*.mjs` and `scripts/*.mjs`. Tests are never mutated.
- **Which tests it runs:** [StrykerJS](https://stryker-mutator.io/) `@stryker-mutator/core` 10.0.0 with its
  built-in `command` test runner, so the tests stay plain `node --test` files. Hook files run against
  `node --test .claude/hooks/tests/guard-bash.test.mjs .claude/hooks/tests/gate-refusal-corpus.test.mjs`; a
  script `scripts/<name>.mjs` runs against `scripts/tests/<name>.test.mjs`, and a changed script without one
  is reported. `.claude/hooks/tests/shell-reader.test.mjs` is never in a command: it pins the reader's
  sha256, so it fails for every mutant and would count each one as killed.
- **No dependency:** Stryker is installed with `npm install --prefix <dir> --no-save --ignore-scripts
  @stryker-mutator/core@10.0.0`, outside the checkout; the repository has no `package.json`.
  `scripts/mutation-check.mjs` is dependency-free and `stryker.config.mjs` holds the Stryker settings.
- **Result:** exit 0 means no new survivor, 1 a new survivor (each listed with a ready-to-fill ledger entry,
  and in the step summary under GitHub Actions), 2 the check could not run. A full guard test run is about
  30 s and runs once per mutant.
- **In CI:** the advisory `Mutation check on changed lines (advisory)` job that runs it on each pull request
  is the `mutation` job in [`agent-tooling.yml`](../.github/workflows/agent-tooling.yml). It is
  `continue-on-error`, pull requests only, and never a required check.
- **What to do with a survivor:** add a test that fails on it. If it is equivalent (behaves the same) or
  harmless over-refusal (the guard refuses more, never less), add the printed entry to
  `.mutation-survivors.json` with a real reason. Entries match on file, mutator, original and replacement
  text, not on line numbers, so they survive edits elsewhere in the file. A survivor that lets the guard
  allow a command it should refuse is never accepted.
- **By hand:** install Stryker as above into a temporary directory, then
  `node scripts/mutation-check.mjs --base origin/main --stryker <dir>/node_modules/.bin/stryker`.
  `--dry-run` prints the Stryker runs without starting them; `--report <file>` checks existing Stryker JSON
  reports against the ledger.

## How to read a red signal

- **`Lint`**: a `ruff check .` finding; fix the code, do not widen the ignore
  list in `pyproject.toml` (a Tier 2 path in [risk-tiers.md](risk-tiers.md)).
- **`Unit tests (debian 12)` red, `(debian 13)` green** (or the reverse): a
  Python-version or package-version difference. Product code must run on
  Python 3.11, which is what Debian 12 ships.
- **`E2E (debian container)`**: the scripts failed inside a throwaway
  container, never on a host. Look at which step of `tests/e2e/in-container.sh`
  printed the failure; it is not a flake until it has been rerun and passed
  with the same commit.
- **`Coverage gate`**: coverage fell below `fail_under`. Add the missing
  test; lowering the floor is a Tier 2 change that needs the owner.
- **`policy-check`**: a rule in `policies/` failed; the output names the rule
  and the offending file.
- **`agent-tooling`**: a hook test or a gate-refusal corpus entry
  (`tests/fixtures/gate-refusal-corpus.json`) failed. Treat it as a security
  regression until proven otherwise: the hook is what keeps agents off the
  host (see [agent-boundaries.md](agent-boundaries.md)).
- **Green on a stale branch**: required checks run on the PR branch. Check the
  branch is current with `main` before trusting a green run.

## Where to look

```bash
# latest runs of the main gate
gh run list --repo Danathar/dns-failover --workflow ci.yml --limit 10
# one run, with failing steps
gh run view <run-id> --repo Danathar/dns-failover --log-failed
# PR metrics, current
gh pr list --repo Danathar/dns-failover --state all --limit 500 \
  --json number,author,state,createdAt,mergedAt,closedAt,labels,title \
  | node scripts/pr-metrics.mjs
# the same checks, locally, from the repo root
python3 -m pytest && ruff check .
python3 -m coverage run -m pytest && python3 -m coverage report
node scripts/check-policies.mjs
node --test 'scripts/tests/*.test.mjs' '.claude/hooks/tests/*.test.mjs'
```

The first reading of the PR metrics is
[metrics/2026-10-11.md](metrics/2026-10-11.md): six pull requests existed, all open (the ACMM rollout),
so every rate in it is `n/a`.

## Known weak spots

- **Nothing exercises the real host.** The product ends in privileged
  changes: `dns-upstream-check.py` signals the live dnsmasq, the installers
  rewrite `/etc/dnsmasq.conf` and enable units, and `monitor.py` changes a
  tailnet's DNS settings through the live Tailscale API. By the host rule
  ([AGENTS.md](../AGENTS.md)) none of that runs outside the unit tests (fakes,
  temp directories) and the container e2e test. A real `dig` against ControlD
  or Cloudflare, a real Tailscale API response shape change, and real dnsmasq
  behaviour on SIGHUP are only ever seen by the owner on the live server.
- **Line coverage is approximate.** It counts executed lines, not whether the
  failure paths are asserted. Review the tests for the paths in
  [review-rubric.md](review-rubric.md) (both-fail, reload failure, API
  change mid-update, installer rollback) directly.
- **`dns-upstream-probe.py` is network-only.** It diagnoses DoT reachability
  against the real resolvers, so it is not run in CI.
- **Acceptance rate needs an independent decider.** Until agent-authored PRs
  are decided by someone other than their author, the rate says little about
  quality; see [metrics.md](metrics.md#how-to-read-the-numbers).
