# Strategy

This page says why `Danathar/dns-failover` exists, what it deliberately does not
do, what actually puts it at risk, which goals are measured and where, and what
the measurements said on the date below. Rules for agents are in
[`AGENTS.md`](../AGENTS.md); how agents share the repository is in
[`multi-agent.md`](multi-agent.md).

Every `gh` example here targets this repository: commands pass `--repo Danathar/dns-failover`, and read-only `gh api` examples name it in the endpoint path.

## Why this repository exists

From [`README.md`](../README.md):

- **A resolver that should not have one point of failure.** The house DNS
  server runs dnsmasq in front of two local Stubby listeners: a primary
  (ControlD, 127.0.0.1:5453) and an independent DNS-over-TLS backup
  (Cloudflare Families, 127.0.0.1:5454).
- **Local failover.** `dns-upstream-check.py` runs as root about every five
  seconds (`dns-upstream-check.timer`), checks both listeners, atomically
  rewrites `/run/dns-upstream/servers.conf` and `state.json`, and signals
  dnsmasq. It moves to the backup after one failed primary check if the backup
  answers, returns after three healthy primary checks, and keeps the current
  selection if both fail.
- **Tailnet failover.** `tailscale-dns-failover/monitor.py` runs about every 20
  seconds, checks ControlD over HTTPS and, after three failures with the local
  backup answering, uses the Tailscale API to turn the tailnet-wide "Override
  DNS servers" setting off so tailnet devices fall back to their own resolvers.
  Restoring it is optional (`auto_restore`, default false).
- **Installers with rollback.** `install-dns-failover.sh` backs up
  `/etc/dnsmasq.conf`, runs `dnsmasq --test` and restores the backup if the
  check or the restart fails.
- **Shared with site specifics removed.** The README says ControlD profile IDs,
  LAN addresses, tailnet names and credentials were removed. That stays true.
- **GPL-3.0-or-later** ([`LICENSE`](../LICENSE)).
- **Agents help maintain it.** The owner uses AI agents (Hive agents, Claude
  workflows, local Claude Code or omp sessions) to build and review changes. The
  ACMM issues (`[ACMM L<n>]`) are the scaffolding that makes that safe and
  auditable. Because the code runs as root and decides what the network
  resolves, safe matters more here than fast.

## What ACMM level means here

ACMM (the agentic maturity model Hive evaluates repositories against) is checked
by whether listed files, directories and settings exist. Here the rollout's intent is that
each criterion is met with working content: every file is read by a test, a
workflow, the hook or a person, and none is a stub. That is the end state once
the pull requests in the ledger merge; the status table below is the baseline
before them. Reaching a level is evidence that agents can work
here with guardrails; it says nothing about whether the failover is correct.
That is what the tests and the risks below are for.

## What it will not do

- Be exercised by an agent against the real host, resolver or Tailscale API
  (the host rule in [`multi-agent.md`](multi-agent.md#rule-1-the-host-rule)).
- Hold a credential, ControlD profile ID, LAN address or tailnet name in the
  repository.
- Grow into a general DNS manager: it chooses between two configured upstreams
  and flips one Tailscale setting.
- Let an agent merge its own pull request, or widen its own permissions. A merge
  is a human's, or the Hive serialized lane's after the required checks pass.

## The real product risks

Priorities follow from these, in this order:

1. **Failover correctness.** A wrong selection, a flapping selection, or a
   half-written `servers.conf` takes DNS down for the whole network. Covered by
   unit tests of the decision logic and the atomic write in
   `dns-upstream-check.py`, and by the e2e test in a container; watch for
   changes to the thresholds (1 failure out, 3 healthy back, keep on both
   failing) and to the PID check against `/proc/<pid>/comm` before SIGHUP.
2. **Tailnet-wide override writes.** `monitor.py` changes a setting that affects
   every device on the tailnet, using OAuth credentials. A false positive
   disables DNS filtering for everyone; a failed restore leaves it off. Covered
   by the 18 offline tests in `tailscale-dns-failover/test_monitor.py` with fake
   API responses. `--dry-run` is not a safe preview: it uses real credentials
   against the live API.
3. **Installer rollback.** Both installers run as root on a live server. The
   promise is that a bad config is rolled back, not left half-installed.
4. **Untested installer paths.** The installers and `configure.py` are the
   least covered code, because they cannot be run on the host. The e2e test
   runs them in a throwaway container; anything it does not reach is a known
   gap and a reason for owner review, not for an agent to try it on the host.

## Measurable goals

Each goal names the place it is measured. Most of those places are added by the
ACMM pull requests in [`agent-tasks/2026-10-11.md`](agent-tasks/2026-10-11.md);
once they merge, each file's own header is the source of truth. Run the command
for today's answer.

| goal | measured by | where |
|---|---|---|
| Reach and hold the target ACMM level | the ACMM evaluator's result for this repo; open criteria are the `[ACMM L<n>]` issues | `gh issue list --repo Danathar/dns-failover --state open --limit 100` (titles start with `[ACMM`) |
| `main` stays green | the jobs in `.github/workflows/ci.yml` (`Lint`, `Unit tests (debian 12)`, `Unit tests (debian 13)`, `E2E (debian container)`) on pushes to `main` | `gh run list --repo Danathar/dns-failover --workflow ci.yml --branch main --limit 10 --json createdAt,conclusion` |
| Tests do not lose coverage | the floor `fail_under` in `[tool.coverage.report]` of `pyproject.toml`, enforced by `.github/workflows/coverage-gate.yml` (job `Coverage gate`); a floor guards against regression, it is not a target to climb | `gh run list --repo Danathar/dns-failover --workflow coverage-gate.yml --branch main --limit 10 --json createdAt,conclusion` |
| Policy holds | `scripts/check-policies.mjs` over `policies/` in the `policy-check` job | `gh run list --repo Danathar/dns-failover --workflow policy-check.yml --branch main --limit 10 --json createdAt,conclusion` |
| Change flow is visible | PR counts, review findings, CI outcomes, read by `scripts/pr-metrics.mjs` | [`metrics.md`](metrics.md), dated snapshots in [`metrics/`](metrics/) |
| Agent work is traceable | every agent PR has `Closes #N`, a signature line and a merger that is a human or the Hive serialized lane | [`agent-tasks/`](agent-tasks/README.md), the `agent-audit.yml` run summary |

None of these is a velocity target. Throughput and coverage percentage are not
goals; optimising them would mean rushing review or padding tests.

## Status on 2026-10-11

Read on 2026-10-11 at `origin/main` = `1c5cf8d` (the repository's only commit).
Left as it was read; the next reading is a new dated section or file, not an
edit.

| measure | reading | how it was read |
|---|---|---|
| Repository | public, default branch `main`, one commit | `git log --oneline origin/main` |
| CI on `main` | no workflow files at `1c5cf8d` | `git ls-tree -r --name-only 1c5cf8d` |
| Tests | one file, `tailscale-dns-failover/test_monitor.py` (18 offline unittest tests); none for `dns-upstream-check.py` or the installers | same listing |
| ACMM | 50 open `[ACMM L<n>]` issues (#1 to #50), one per missing criterion; #42 is a repository setting handled outside the slice pull requests | `gh issue list --repo Danathar/dns-failover --state open --limit 100` |
| Hive | repository paused in Hive until this work lands and the ACMM evaluation is re-run | the Hive dashboard card; not recorded by this page afterwards |

## Keeping this page honest

Do not put a number here that a later commit can make false without dating it.
The status table is a dated reading; everything above it is commands and
reasons. When you change a command, run it and check it prints what the text
says.
