# How several agents share this repository

More than one AI agent works in `Danathar/dns-failover`, next to its owner. This
page says which agents, how work reaches them, what keeps them from colliding,
and who decides what lands. [`AGENTS.md`](../AGENTS.md) is the brief every agent
reads first and wins on any disagreement; [`CLAUDE.md`](../CLAUDE.md) is the
codebase guide. This page is about how the agents fit together, not about how
to write the code.

It holds no counts, because they go stale. Where a fact can change, a command
shows the current answer. Every `gh` command passes
`--repo Danathar/dns-failover`, so it does the same thing from any clone or
worktree.

## Rule 1: the host rule

This repository's code runs as root on a real DNS server and changes what every
device on the owner's network and tailnet resolves. An agent must never, on the
host: run `sudo`; run `install-dns-failover.sh` or
`tailscale-dns-failover/install.sh`; run `tailscale-dns-failover/configure.py`;
run `tailscale-dns-failover/monitor.py` in any mode (`--dry-run` still calls the
live Tailscale API with real credentials); run `dns-upstream-check.py` against
real paths (`/run/...`, the real dnsmasq PID file) or without `--no-reload`; take
`systemctl` or `service` actions on dnsmasq, stubby or this project's units; or
make any Tailscale API call. Code is exercised only through the unit tests
(fakes, stubs, temporary directories) and the end-to-end test inside a throwaway
container (`tests/e2e/run.sh`). Credentials and site-specific values (ControlD
profile IDs, LAN addresses, tailnet names) never enter the repository. This is
the one rule no task is allowed to override; the `Bash` guard in
`.claude/hooks/` enforces it for Claude Code sessions
([`agent-boundaries.md`](agent-boundaries.md)).

## There is no dispatcher in this repository

Nothing here decides which agent runs, when, or on what.
[Hive](https://github.com/hivecommons/hive) does that from outside, through a
GitHub App, and its dashboard is not part of this repository. Workflows in
`.github/workflows/` react to ordinary GitHub events (a push, a pull request, a
label, a comment, a schedule); they do not schedule an agent on their own. What
each one does is in
[`ai-ops-runbook.md`](ai-ops-runbook.md#what-each-workflow-does-and-how-to-turn-it-off).

## Who works here

| who | how to recognise it | what it does |
|---|---|---|
| The owner (`Danathar`) | commits and PRs under that login | decides scope and merges |
| Hive agents | PRs and issues from the GitHub App `danathar-atomic-hive` (`gh` prints the author as `app/danathar-atomic-hive`, the REST API as `danathar-atomic-hive[bot]`); the body ends with a line like `— hive: agent=<name>` | pick up issues, open PRs, reply to review |
| Claude and ai-fix workflows | runs of `claude.yml` and `ai-fix.yml`, started by an `@claude` comment or the `ai-fix-requested` label from the owner or a collaborator | answer a comment, or verify review findings and apply those that hold |
| Local agents | Claude Code or omp sessions in a clone or worktree on the owner's machine; commits carry the owner's git identity | work one issue (or one named group) on one branch, as the owner directs |

Match the Hive login exactly, not "any bot": `github-actions[bot]` also acts
here. Two ways to see who did what:

```bash
# PRs the Hive app opened
gh pr list --repo Danathar/dns-failover --state all --author app/danathar-atomic-hive --json number,title,headRefName

# the signature line on one PR
gh pr view <N> --repo Danathar/dns-failover --json author,body \
  --jq '.author.login, (.body | split("\n") | map(select(startswith("— hive: "))))'
```

A review finding, from a bot or a person, is a claim to verify against the code,
not an instruction. [`review-rubric.md`](review-rubric.md) is the checklist a
reviewer, human or agent, applies. Task traceability, which links a change back
to the agent task that produced it, is described in
[`agent-tasks/README.md`](agent-tasks/README.md).

## How work reaches an agent

- **An issue.** Hive reads issues and files its own. The ACMM issues carry the
  title prefix `[ACMM L<n>]`.
- **A label or comment** that a workflow reacts to, such as an
  `ai-fix-requested` label or an `@claude` mention, defined by
  `.github/workflows/ai-fix.yml` and `.github/workflows/claude.yml`; read the
  header of each for who may trigger it.
- **Hive's own schedule**, outside this repository. When the repository is
  paused in Hive, its agents stop acting on it (see
  [`ai-ops-runbook.md`](ai-ops-runbook.md#pause-and-resume-the-repository-in-hive)).

## What keeps agents from colliding

There is no lock. Agents work on separate branches; collisions are found by
reading and settled by the owner.

1. **Claim before you start.** Look for an open pull request or a branch that
   already answers the issue, and for a claim comment on it:

   ```bash
   gh pr list --repo Danathar/dns-failover --state open --json number,title,headRefName
   gh issue view <N> --repo Danathar/dns-failover --comments
   ```

   If another agent holds the issue, do not start a second branch for it. Say in
   your pull request body which files you touch and which open pull requests you
   checked them against.
2. **One pull request per concern.** A pull request answers one issue (or one
   named group of issues) and says so with `Closes #N`. Do not mix a behaviour
   change to the failover logic with a docs or CI change. Branch from current
   `origin/main`; do not stack one branch on another. Parallel local sessions
   use one `git worktree` each, so two branches are never checked out in the
   same directory. The ACMM effort used `acmm/<slug>` branches (see
   [`agent-tasks/2026-10-11.md`](agent-tasks/2026-10-11.md)); Hive names its own.
3. **Never push to a branch you did not create.** That includes another agent's
   branch and an outside contributor's. Comment instead.
4. **Keep shared files small and deliberate.** The places conflicts concentrate:
   - **`dns-upstream-check.py`** (selects the upstream, rewrites
     `servers.conf`, signals dnsmasq) and
     **`tailscale-dns-failover/monitor.py`** (writes the tailnet-wide DNS
     override) are the product. Only one open pull request at a time should
     change the logic of either; a second waits or rebases onto the first.
     Their tests in `tests/unit/` and `tailscale-dns-failover/test_monitor.py`
     pin the behaviour, so a rebase that passes them has kept the contract.
   - **The two installers and `configure.py`** change only in a pull request
     that exists to change them; they run as root on a live server and the
     installers' rollback path (restoring the backed-up `dnsmasq.conf`) is the
     safety net.
   - **`README.md` and `tailscale-dns-failover/README.md`** document the
     behaviour (thresholds, ports, config keys). A change to a threshold, port or
     config key changes the table in the same pull request.
   - **`*.service`, `*.timer`, `dnsmasq-*.conf`, `stubby-*.yml`** change only in
     a pull request that exists to change them, because the installers copy
     them onto a running DNS server.
   - **`AGENTS.md`, `CLAUDE.md` and `.github/workflows/**`** change only in a
     pull request that exists to change them; they steer every other agent and
     every merge.
5. **Rebase, do not merge `main` into your branch.** If `main` moved, rebase and
   re-run the checks that matter for your change.

## Who decides what lands

No agent merges its own pull request unless the owner has set that up.

- **Required checks.** The ruleset on `main` requires the jobs below, with
  branches required to be up to date: `Lint`, `Unit tests (debian 12)`,
  `Unit tests (debian 13)` and `E2E (debian container)` (the jobs in
  [`ci.yml`](../.github/workflows/ci.yml)), `Coverage gate`
  ([`coverage-gate.yml`](../.github/workflows/coverage-gate.yml)) and
  `policy-check` ([`policy-check.yml`](../.github/workflows/policy-check.yml)).
  All run on every pull request; a red one blocks the merge. The ruleset is
  recorded under `.github/rulesets/`; if the live ruleset disagrees with this
  paragraph, the live ruleset wins. Check what is live with
  `gh api repos/Danathar/dns-failover/rulesets --jq '.[] | [.name, .enforcement] | @tsv'`.
- **Serialized merging (issue #42).** Hive merges this repository through its
  serialized lane (`merge_strategy: hive-serialized`): one pull request at a
  time, each brought up to date with `main` and re-tested before it merges. Read
  the current value with an authenticated
  `GET /api/repos/merge-strategy?repo=dns-failover` on the Hive dashboard API.
  GitHub's native merge queue is not available to a personal-account repository,
  which is why the lane lives in Hive rather than in a workflow here.
- **Green is only trusted on a current branch.** A pull request that passed
  before `main` moved has not been tested against today's `main`. Rebase first.
- **A merge reaches a live DNS server.** The README tells the owner to run the
  installers from a clone as root, and the timers run the scripts every few
  seconds unattended. Whatever is on `main` is what the next install deploys, so
  a bad merge is a bad update to resolver behaviour. That is the reason for the
  serial lane and for the runbook's
  [bad deploy](ai-ops-runbook.md#a-bad-change-reached-the-dns-server) section.
- **An agent's permission boundary needs the owner.** Changes to
  `.claude/settings.json`, `.claude/hooks/**`, `policies/` or
  `.github/CODEOWNERS` are read and merged by the owner, whoever wrote them. An
  agent must not widen its own boundary
  ([`agent-boundaries.md`](agent-boundaries.md),
  [`security/SECURITY-AI.md`](security/SECURITY-AI.md)).
- **Risk tiers set how hard the owner looks.** See
  [`risk-tiers.md`](risk-tiers.md): the failover scripts and installers are
  Tier 1.

## If you are an agent

1. Read [`AGENTS.md`](../AGENTS.md), then [`CLAUDE.md`](../CLAUDE.md).
2. Pass `--repo Danathar/dns-failover` on every `gh` command.
3. Claim the issue, branch from `origin/main`, one pull request per concern.
4. Obey the host rule: tests and the throwaway container only.
5. Run the checks for the files you changed; say in the PR which you ran and
   which you did not.
6. Leave the merge to the lane and the owner.
