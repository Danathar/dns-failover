# AI operations runbook

For the owner. It says how to notice each automated signal in this repository,
what to check first, what to do, and how to stop each automation.

**The safety rule comes first.** This repository's scripts run as root on a live
DNS server, and `monitor.py` changes a tailnet-wide setting through the
Tailscale API. Nothing in this runbook, and no agent, runs the installers,
`configure.py`, `monitor.py` (even with `--dry-run`, which uses real credentials
against the live API), `dns-upstream-check.py` against real paths, or
`systemctl` actions "to see what happens". Reproduce with the unit tests or in a
throwaway container (`tests/e2e/run.sh`). The commands in the last two sections
read the server's state; they are **owner-run commands, run by the owner on the
server, never by an agent**. Every `gh` command here passes
`--repo Danathar/dns-failover`.

| signal or need | section |
|---|---|
| Stop all agent work | [Pause and resume the repository in Hive](#pause-and-resume-the-repository-in-hive) |
| What does each workflow do, how do I turn it off | [What each workflow does](#what-each-workflow-does-and-how-to-turn-it-off) |
| Red `main` | [A red `main`](#a-red-main) |
| An agent PR touches a Tier 1 path | [An agent pull request touches Tier 1](#an-agent-pull-request-touches-tier-1) |
| DNS misbehaves after a merge was installed | [A bad change reached the DNS server](#a-bad-change-reached-the-dns-server) |
| A token or key appeared in a commit, log or comment | [A leaked secret](#a-leaked-secret) |
| An agent is looping or doing the wrong thing | [A runaway agent](#a-runaway-agent) |
| A scheduled run never appeared | [A scheduled run did not fire](#a-scheduled-run-did-not-fire) |
| Someone asks what the resolver is doing now | [The product's own operational signals](#the-products-own-operational-signals) |

## Pause and resume the repository in Hive

Hive is outside this repository. Its per-repo pause stops agent activity on
`Danathar/dns-failover` only, and leaves the card on the dashboard, its counts
and its ACMM evaluation in place. It is a different switch from pausing one
agent (everywhere) or the whole fleet.

- **Dashboard:** on the repo's card under PROJECTS, the owner presses "pause"
  (it asks for a reason) or "resume".
- **API:** `POST /api/repos/pause` with `{"repo": "<name>", "reason": "..."}`,
  `POST /api/repos/resume` with `{"repo": "<name>"}`, and
  `GET /api/repos/pauses` to list. Pause and resume are owner-only.

Source: Hive's `src/docs/repo-pause.md`. Whether this repository is paused right
now is shown on the dashboard; this page does not record it.

What pausing does not do:

- It does not stop GitHub workflows. Those are switched off per workflow (next
  section).
- It does not stop review bots or a local Claude Code or omp session.
- It does not undo anything an agent already pushed.

Confirm that Hive has stopped by looking for new bot activity:

```bash
gh pr list --repo Danathar/dns-failover --state all --author app/danathar-atomic-hive --limit 5 --json number,createdAt,title
```

## What each workflow does, and how to turn it off

All live in [`.github/workflows/`](../.github/workflows/). Disable one without
deleting it (this changes repository settings; it is reversible, and `enable`
brings it back). A workflow can be named by its file name, so no `name:` needs
looking up:

```bash
gh workflow disable <file>.yml --repo Danathar/dns-failover
gh workflow enable  <file>.yml --repo Danathar/dns-failover
gh workflow list --repo Danathar/dns-failover --all
```

Disabling a required check leaves pull requests waiting for a status that never
arrives. Disable `CI`, `Coverage gate` or `Policy check` only if you also relax
the ruleset under [`.github/rulesets/`](../.github/rulesets/). To remove a
workflow permanently, delete the file in a pull request.

| file | `name:` | what it does and when it runs |
|---|---|---|
| `ci.yml` | `CI` | jobs `Lint`, `Unit tests (debian 12)`, `Unit tests (debian 13)`, `E2E (debian container)`; every pull request and every push to `main` |
| `coverage-gate.yml` | `Coverage gate` | measures coverage of the Python code under the tests and fails below `fail_under` in `pyproject.toml`; pull requests and pushes to `main` |
| `policy-check.yml` | `Policy check` | runs `scripts/check-policies.mjs` over `policies/` and `risk-config.json`, then its tests; pull requests and pushes to `main` |
| `agent-tooling.yml` | `Agent tooling` | `node --test` over `scripts/tests/` and `.claude/hooks/tests/`; pull requests and pushes to `main` |
| `pr-metrics.yml` | `PR metrics` | scheduled and manual: runs `scripts/pr-metrics.mjs`, writes a step summary and an artifact; read-only ([`metrics.md`](metrics.md)) |
| `nightly-compliance.yml` | `Nightly compliance` | scheduled and manual: repeats the test and lint jobs; on failure opens or updates one tracking issue and never closes it |
| `auto-qa.yml` | `Auto-QA` | scheduled and manual: measures coverage, runs `scripts/auto-qa-tuner.mjs` with `.github/auto-qa-tuning.json`, and opens or updates one issue proposing a higher floor; never commits, never lowers a floor |
| `agent-audit.yml` | `Agent audit trail` | scheduled and manual: `scripts/ai-audit-report.mjs` checks agent PRs for a linked issue, a signature line and a human (or Hive lane) merger; a violation turns the run red, nothing is written |
| `auto-issues.yml` | `Auto issues` | when `CI` fails on a push to `main`, opens or comments on one tracking issue; never closes it |
| `ai-fix.yml` | `AI fix requested` | on label `ai-fix-requested` or an `/ai-fix` comment from the owner, a member or a collaborator, asks Claude Code to verify review findings and apply those that hold; skips bots and fork PRs |
| `claude.yml` | `Claude` | an `@claude` comment from the owner, a member or a collaborator; refuses fork PRs; without an Anthropic credential it writes a summary and skips |
| `labeler.yml` | `Labeler` | labels pull requests by changed paths using [`.github/labeler.yml`](../.github/labeler.yml); skipped for fork PRs |

These are the workflows in the pull requests listed in
[`agent-tasks/2026-10-11.md`](agent-tasks/2026-10-11.md); each exists on `main`
only once its pull request merges. A header comment at the top of each file
explains its triggers and gating; that header, not this table, is the source of
truth if they differ. Get the exact `name:` with
`grep -m1 '^name:' .github/workflows/<file>`.

The agent workflows hold a write token, so they never use `pull_request_target`
and they skip bots and outsiders before doing anything. If you doubt one,
disable it first and read it afterwards.

### Reading audit, metrics and nightly output

```bash
gh run list --repo Danathar/dns-failover --workflow agent-audit.yml --limit 3
gh run view <run id> --repo Danathar/dns-failover      # the step summary lists violations
gh run list --repo Danathar/dns-failover --workflow nightly-compliance.yml --limit 7
gh issue list --repo Danathar/dns-failover --state open --search 'in:title nightly OR "main is red"'
```

A red audit run names the PR that lacks a closing reference, a signature line,
or a human/Hive-lane merger; fix the record in the PR or the ledger
([`agent-tasks/`](agent-tasks/README.md)), not the audit. Metrics output is
described in [`metrics.md`](metrics.md).

## A red `main`

Signal: a run of `CI` on a push to `main` fails, or `auto-issues.yml` opened an
issue for the failing workflow.

```bash
gh run list --repo Danathar/dns-failover --workflow ci.yml --branch main --limit 5
RUN=<run id>
gh run view "$RUN" --repo Danathar/dns-failover --json jobs \
  --jq '.jobs[] | {name, conclusion, failed: [.steps[] | select(.conclusion=="failure") | .name]}'
gh run view "$RUN" --repo Danathar/dns-failover --log-failed
```

1. **Which job.** `Lint` is ruff or shellcheck; a unit-test job names the test
   that pinned the behaviour (the two Debian jobs run different Python versions,
   so a failure in one only is usually a version issue); `E2E (debian container)` is the container run of the
   installers.
2. **Was it the last commit or the environment.** Re-run once
   (`gh run rerun "$RUN" --repo Danathar/dns-failover --failed`). A pass on
   re-run is a flake; note it in the tracking issue. A new package version in a
   container image is the usual environmental cause.
3. **Fix forward or revert.** If the cause is clear, fix in a branch and pull
   request as usual. If not, revert the offending merge in a pull request
   (`git revert -m 1 <merge sha>`). Do not push to `main` directly.
4. **Remember what `main` is.** The owner installs from this repository as root.
   If the broken commit changed a Tier 1 script or installer, treat it as a
   possible [bad change on the server](#a-bad-change-reached-the-dns-server) as
   well as a red check.
5. **Close the tracking issue by hand** when `main` is green again;
   `auto-issues.yml` does not close one.

## An agent pull request touches Tier 1

Signal: a pull request from an agent changes a path in Tier 1 of
[`risk-tiers.md`](risk-tiers.md): workflows, `.claude/settings.json`,
`.claude/hooks/**`, `policies/**`, `CODEOWNERS`, either installer, `configure.py`,
`monitor.py` or `dns-upstream-check.py`.

1. **Confirm it is expected.** Compare the diff with the issue named in
   `Closes #N`. A Tier 1 change the issue does not ask for is a reason to close
   the PR, not to review it.
   `gh pr diff <N> --repo Danathar/dns-failover --name-only`
2. **Read it as the owner.** CODEOWNERS requests your review; the serialized
   lane merges only after the required checks pass, and passing checks do not
   replace reading a change to what runs as root or to an agent's own
   permissions ([`agent-boundaries.md`](agent-boundaries.md)).
3. **For the failover scripts**, check that the thresholds, the atomic write and
   the PID check are covered by a test that fails without the change, and that
   the PR states which tests it ran. It cannot have run the real thing; if it
   says it did, close it and read [the host rule](multi-agent.md#rule-1-the-host-rule).
4. **For the boundary** (`.claude/`, `policies/`, workflows), ask whether it
   widens what an agent may do. If so, it needs the owner's explicit decision.
5. Do not hand-edit the agent's branch; comment, or take over in your own.

## A bad change reached the DNS server

Signal: after the owner installed or updated from `main`, name resolution is
slow, wrong or absent, or the Tailscale DNS override was switched off when it
should not have been. The commands below are **owner-run, on the server**.

**Stop the cause first.**

```bash
sudo systemctl disable --now tailscale-dns-failover.timer   # stop tailnet override changes
sudo systemctl disable --now dns-upstream-check.timer       # freeze the selection
```

Both timers are this project's own; disabling them leaves the last
`servers.conf` in place. If DNS is down, the installer's backup of
`/etc/dnsmasq.conf` is the way back; read what the installer printed when it
ran, and `dnsmasq --test` before restarting dnsmasq.

**If the tailnet override was turned off**, it stays off unless `auto_restore`
is enabled. Turn it back on in the Tailscale admin console DNS page (a manual
step; no agent calls that API), then decide whether to re-enable the monitor.

**Fix the cause in this repository:**

- Revert the offending merge by pull request, say in the PR what must be
  reinstalled (rerun the installer from a clean clone), and add a test that
  fails on the bad behaviour first.
- Record the incident in the day's ledger under
  [`agent-tasks/`](agent-tasks/README.md).

## A leaked secret

Signal: a token, key or credential in a commit, a PR, an issue, a log or a
comment. The secrets that matter here are the Tailscale OAuth client ID and
secret (in the root-only `config.json` on the server, never in the repository),
the Anthropic credential used by `claude.yml` and `ai-fix.yml` if the owner
added one, and any Hive tokens. `ci.yml` needs no secret.

1. **Revoke first.** Rotate or delete the credential at its issuer (for
   Tailscale, delete the OAuth client in the admin console), before cleaning the
   repository. History cleanup does not un-leak a secret that was public.
2. Disable the workflow that used it (table above) until a new one is set.
3. Remove it from the visible surface: edit or delete the comment or issue body;
   for a commit, a revert does not remove it from history, so the owner decides
   about rewriting history of a branch (never of `main` without a plan).
4. Replace it with `gh secret set <NAME> --repo Danathar/dns-failover`, run by
   the owner so the value is never in a transcript.
5. Record it in the day's ledger without the value.

## A runaway agent

Signal: a Hive agent or a workflow opening many PRs or comments, rewriting the
same files, or acting outside its issue.

1. **Pause the repository in Hive** (first section). Then disable `ai-fix.yml`
   and `claude.yml` if a workflow agent is involved.
2. **Stop what is queued.** Cancel running workflows:
   `gh run cancel <run id> --repo Danathar/dns-failover`; list with
   `gh run list --repo Danathar/dns-failover --status in_progress`.
3. **Contain the output.** Close its open pull requests
   (`gh pr close <N> --repo Danathar/dns-failover`) and keep the branches for
   evidence. Nothing it opened should merge: the serial lane and the required
   checks are why a runaway cannot land by volume, so confirm the ruleset is
   active (`gh api repos/Danathar/dns-failover/rulesets`).
4. **Check what merged.**
   `gh pr list --repo Danathar/dns-failover --state merged --author app/danathar-atomic-hive --limit 20`,
   and the `agent-audit.yml` run summary. Revert anything wrong by pull request;
   if it touched a Tier 1 script, also read
   [a bad change on the server](#a-bad-change-reached-the-dns-server).
5. **Find why** before resuming: the issue text it followed, the instructions in
   [`AGENTS.md`](../AGENTS.md), the guard and permission settings in
   [`agent-boundaries.md`](agent-boundaries.md). Fix the instruction, not only
   the output.

## A scheduled run did not fire

Scheduled workflows (those with a `schedule:`) run only from the default branch,
can be delayed under load, and GitHub disables schedules in a repository with no
activity for 60 days. Check with
`gh workflow list --repo Danathar/dns-failover --all`; re-enable a disabled one
with `gh workflow enable <file>.yml --repo Danathar/dns-failover`, and start one
by hand with `gh workflow run <file>.yml --repo Danathar/dns-failover`.

The server's own timers are a different thing:
`dns-upstream-check.timer` and `tailscale-dns-failover.timer` use
`OnUnitInactiveSec` (5 s and 20 s) after boot delays (`OnBootSec`), so they
re-arm after each run finishes. Owner-run check on the server:
`systemctl list-timers dns-upstream-check.timer tailscale-dns-failover.timer`.

## The product's own operational signals

These answer "what is the resolver doing", for the owner or when an agent is
asked what to look at. **Owner-run on the server, never agent-run**: an agent
gives the owner the command and reads what the owner pastes back, with any
site-specific value (profile IDs, addresses, tailnet names) removed before it
goes into an issue, PR or ledger.

```sh
systemctl status dns-upstream-check.timer stubby-fallback.service
journalctl -u dns-upstream-check.service --since '10 minutes ago'
journalctl -u tailscale-dns-failover.service --since '1 hour ago'
cat /run/dns-upstream/servers.conf
cat /run/dns-upstream/state.json
dig @127.0.0.1 -p 5453 example.com     # primary (ControlD)
dig @127.0.0.1 -p 5454 example.com     # backup (Cloudflare Families)
dig @127.0.0.1 example.com             # what clients actually get
```

Reading them:

- `servers.conf` names the selected upstream port: 5453 primary, 5454 backup.
  Selection of the backup after one failed primary check is by design; return
  takes three healthy primary checks.
- `state.json` holds `primary_successes` (healthy primary checks toward the
  return, capped at 3) and `reload_pending` (a dnsmasq signal that failed and
  will be retried next cycle). If both listeners fail, the
  selection is kept, so a stale `servers.conf` with both `dig`s failing means the
  upstreams, not the checker, are down.
- `tailscale-dns-failover.service` log lines show the monitor's failure count
  and whether it changed the override. With `auto_restore` false (the default),
  restoring is manual.
- [`README.md`](../README.md#check-local-dns-operation) is the source for these
  commands; if it differs, it wins.
