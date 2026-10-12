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

## Current state (as of 2026-10-11)

The repository is a single initial commit, `1c5cf8d` ("Initial import of
dnsmasq/Stubby/Tailscale DNS failover"). The ACMM rollout (file-existence gap
issues #1-#41 and #43-#50) is in flight as seven parallel slice pull requests,
one per area; none is merged at the time of writing, so most files named in
this tooling (AGENTS.md, `docs/`, `policies/`, workflows from other slices) do
not exist on `main` yet. Re-verify with `git log origin/main` and
`gh pr list --repo Danathar/dns-failover`. Hive is paused on this repository
until the work lands and the ACMM evaluation is re-run. Issue #42 (merge queue /
ruleset) is handled separately by the integrator, not by a slice.

- **What the repo is:** Python 3 (standard library only) and POSIX sh for an
  existing Debian-style DNS server: `dns-upstream-check.py` (primary/backup
  upstream selection, every ~5 s), `dns-upstream-probe.py` (manual DoT
  diagnosis), `tailscale-dns-failover/monitor.py` (tailnet DNS override, every
  ~20 s), two installers, `configure.py`, systemd units, dnsmasq/stubby
  configs and examples. GPL-3.0-or-later.
- **Agent tooling (this slice):** `.claude/hooks/guard-bash.mjs` with tests in
  `.claude/hooks/tests/` (hook cases, the shared gate-refusal corpus in
  `tests/fixtures/gate-refusal-corpus.json`, and `settings.json` structure),
  `.claude/settings.json`, `.claude/memory/`, this file, `docs/reflections/` and
  the `Agent tooling` workflow (job `agent-tooling`).
- **Checks:** `python3 -m pytest`, `ruff check .`, `shellcheck` over
  `git ls-files '*.sh'`, `tests/e2e/run.sh`, `node --test '.claude/hooks/tests/*.test.mjs'`,
  `node --test 'scripts/tests/*.test.mjs'`, `node scripts/check-policies.mjs`.
  Most are added by sibling slices.

## Last session: 2026-10-11 - agent tooling slice of the ACMM rollout

**Done:** the hook, its tests, settings, memory, this summary, the first
reflection and the workflow, in the agent-tooling pull request (the PR that
adds this file). The hook was ported from the reference rollout on
`Danathar/openaudible-autoupdate` with its follow-up fixes, and the host rule
was rewritten for this project.
**In flight:** the six sibling slice PRs (directions, tests/CI, metrics,
governance, automation, operations docs). Hive stays paused until they land.
**Blocked on:** review and merge by the owner; the `Agent tooling` required
check only exists once this PR is on `main`.
**Watch:** the hook reads its `python3 -m pytest` allowlist from the pytest
options known at writing time; a new pytest option in a test command needs a
row in `PYTEST_OPTIONS` in `guard-bash.mjs` (it fails closed, so it shows up
as a refusal, not a hole). `KNOWN_GAPS` in
`.claude/hooks/tests/gate-refusal-corpus.test.mjs` lists corpus rows the gate
still lets through; they are inherited from the reference, not new.

## Open threads

- ACMM slice PRs awaiting review (see `gh pr list --repo Danathar/dns-failover`).
- Issue #42 (merge queue / ruleset) with the integrator.

## Next steps

1. Land the slice PRs, then re-run the ACMM evaluation.
2. Resume Hive on this repository.
3. Rewrite this file from `origin/main` once the work has landed.
