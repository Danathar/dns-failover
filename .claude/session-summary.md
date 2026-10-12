# Session summary

The handoff between working sessions. Read it at the start of a session, after
[AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md); rewrite it at the end.
It carries only what is true right now and would otherwise have to be
rediscovered. Standing rules belong in AGENTS.md, mistakes worth never
repeating in [memory/](memory/README.md), recurring patterns in
[../docs/reflections/](../docs/reflections/README.md).

**Host rule.** Never run, on the host: `sudo`; either installer;
`configure.py`; `monitor.py` in any mode (`--dry-run` calls the live Tailscale
API with real credentials); `dns-upstream-check.py` against real paths or
without `--no-reload`; `systemctl`/`service` on dnsmasq, stubby or the units; any
Tailscale API call. Use `python3 -m pytest` and `tests/e2e/run.sh`.
`guard-bash.mjs` blocks the rest. GitHub writes pass `--repo Danathar/dns-failover`.

## How to use it

Start of session:

1. Read "Current state" and the latest session entry below.
2. Verify anything you are about to rely on. Branch names, PR numbers and SHAs
   drift: check with `git log origin/main`,
   `gh pr list --repo Danathar/dns-failover` and
   `gh issue list --repo Danathar/dns-failover`.

End of session. This file is one tracked singleton, so concurrent PRs that all
rewrite it will conflict or overwrite each other. Rule: only the session that
lands work on `main` (the one that merges, or a dedicated handoff PR opened
after the merge) rewrites it, starting from the current `origin/main` copy. A
session that opens a PR to be merged later puts its notes in the PR body and
leaves this file alone. Steps for the session that updates it:

1. Update "Current state" so it matches what is on `main` now.
2. Replace the "Last session" entry. Overwrite it; do not append a history. What
   is worth keeping long term goes to AGENTS.md, `memory/` or `docs/reflections/`.
3. Rewrite "Open threads" and "Next steps": remove what is finished, and keep
   each remaining item to one line with its issue or PR number.
4. Record only things you observed. Mark guesses as `[INFERENCE]`.

Entry format:

```markdown
## Last session: <YYYY-MM-DD> - <one-line focus>

**Done:** what landed, with PR/issue numbers
**In flight:** open PRs, unmerged branches, half-finished work
**Blocked on:** decisions or merges needed before the next step
**Watch:** observed but not acted on
```

---

## Current state (as of 2026-10-12)

The ACMM rollout has landed. Issues #1-#41 and #43-#50 were closed by slice
pull requests #51-#57; #42 is closed by the ruleset pull request that also
rewrote this file. The ledger with every PR, merge commit and outcome is
[docs/agent-tasks/2026-10-11.md](../docs/agent-tasks/2026-10-11.md). Hive is
still paused on this repository until the owner re-runs the ACMM evaluation.

- **What the repo is:** Python 3 (standard library only) and POSIX sh for an
  existing Debian-style DNS server: `dns-upstream-check.py` (primary/backup
  upstream selection, every ~5 s), `dns-upstream-probe.py` (manual DoT
  diagnosis), `tailscale-dns-failover/monitor.py` (tailnet DNS override, every
  ~20 s), two installers, `configure.py`, systemd units, dnsmasq/stubby
  configs and examples. GPL-3.0-or-later.
- **Protection:** ruleset `24900573` (`protect main`, file
  `.github/rulesets/main.json`, explained in
  [docs/branch-protection.md](../docs/branch-protection.md)) is active. It
  requires a PR, has no bypass, and requires seven checks on an up-to-date
  branch: `Lint`, `Unit tests (debian 12)`, `Unit tests (debian 13)`,
  `E2E (debian container)`, `Coverage gate`, `policy-check`, `agent-tooling`.
  Hive's merge strategy for this repository is `hive-serialized`.
- **Checks:** `python3 -m pytest`, `ruff check .`, `shellcheck` over
  `git ls-files '*.sh'`, `tests/e2e/run.sh`, `node --test '.claude/hooks/tests/*.test.mjs'`,
  `node --test 'scripts/tests/*.test.mjs'`, `node scripts/check-policies.mjs`.
  `node --test <directory>/` does not work on Node 22/24; use the quoted globs.
- **Scheduled workflows:** `nightly-compliance.yml`, `agent-audit.yml`,
  `auto-qa.yml` and `pr-metrics.yml` were each dispatched once on main on
  2026-10-12. Audit, auto-QA and metrics passed. Nightly failed on the runner's
  unpinned shellcheck (#58), which #59 fixes.

## Last session: 2026-10-12 - ACMM rollout integration

**Done:** merged #55 (tests/CI), #52, #54, #53, #56, #51 and #57, each after
updating it with main, green checks and fixing or resolving its Codex P0/P1
threads. Applied ruleset `24900573`. Created the `ai-fix-requested` label.
**In flight:** #59 (nightly shellcheck pin) and the ruleset/handoff PR, if
either is still open.
**Blocked on:** the owner re-running the ACMM evaluation and unpausing Hive.
**Watch:** #57 was merged before its Hive `sentinel-alert` was seen. The alert
was reviewed after the merge as a false positive (test strings only), and the
label was removed with a comment on #57. Before merging, check for
`sentinel-alert` as well as CI and review threads. The hook's `KNOWN_GAPS`
(`.claude/hooks/tests/gate-refusal-corpus.test.mjs`) are inherited from the
reference and still pass through. A new pytest option needs a `PYTEST_OPTIONS`
row in `guard-bash.mjs`; until then it fails closed.

## Open threads

- #58 Nightly compliance failing: close after #59 merges and a re-dispatched
  nightly run is green.

## Next steps

1. Re-run the ACMM evaluation for `dns-failover` (owner, Hive dashboard).
2. Unpause Hive on this repository.
