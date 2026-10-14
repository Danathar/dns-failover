# Branch protection and serialized merging

`main` is what the owner copies onto a live DNS server: the installers put
`dns-upstream-check.py` and `tailscale-dns-failover/monitor.py` under
`/usr/local/sbin`, and their timers run them as root every few seconds,
rewriting dnsmasq's upstream and, for the Tailscale monitor, the tailnet-wide
DNS override. This page says what protects `main`, why, and how to check that
GitHub is really enforcing it. Every command here targets
`Danathar/dns-failover`; see [AGENTS.md](../AGENTS.md).

## Status

The ruleset in [`.github/rulesets/main.json`](../.github/rulesets/main.json) is
**active**. It was applied on 2026-10-12 as ruleset `24900573`. The file now
also requires code owner review (issue #90). That part takes effect only once
the owner PUTs the file to the live ruleset (see "Applying or changing the
ruleset"); until then the diff below prints the one difference,
`require_code_owner_review`. Check it yourself; neither call needs admin
rights:

```bash
gh api repos/Danathar/dns-failover/branches/main --jq .protected
gh api repos/Danathar/dns-failover/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

The first prints `true`; the second lists `protect main` as `active`. Anything
else means the ruleset was removed or disabled and `main` again accepts a
direct push from any token with `contents: write`.

Being active does not prove the rules are the ones in the file; an edit in the
GitHub UI could leave only `deletion`. Compare the live ruleset with the file
(prints nothing when they match; it needs no admin rights):

```bash
diff <(gh api repos/Danathar/dns-failover/rulesets/24900573 \
         --jq '{name,target,enforcement,conditions,rules}' | jq -S .) \
     <(jq -S '{name,target,enforcement,conditions,rules}' \
         .github/rulesets/main.json)
```

GitHub returns `bypass_actors` only to a repository admin. Anyone else gets
`null` there, which would always differ from the file's `[]`, so the command
above leaves the field out. The owner checks it as well by adding
`bypass_actors` to both field lists; that diff must also print nothing.

The nightly compliance workflow runs the same comparison every night and fails
the `policies` job when the live ruleset differs from the file, so a drift
reaches the nightly tracking issue instead of waiting for someone to look.

GitHub fills in defaults for `pull_request` parameters that were not sent
(`require_extra_approval_for_unattributed_changes: true`,
`required_reviewers: []`); the file spells them out so this diff stays empty.

## Why

Every gate in this repository sits behind a pull request: the unit and
end-to-end tests, the coverage floor, the policy check that keeps
`install-dns-failover.sh` validating the new dnsmasq config and restoring the
backup on failure, and the hook tests. Without a ruleset nothing made anyone
open one. Two kinds of token can write `main` without a person reading the
change:

- The Hive GitHub App (`danathar-atomic-hive`), which pushes branches for
  agents that read issue and pull request text written by others.
- Workflows that hold `contents: write` (`claude.yml`, `ai-fix.yml`).

## The ruleset

[`.github/rulesets/main.json`](../.github/rulesets/main.json) is in GitHub's
import format, so it applies as-is.

- **Targets `~DEFAULT_BRANCH`**, so it follows a rename of `main`.
- **No bypass actors.** A bypass for Actions or for an App hands back the
  direct push this exists to stop.
- **`deletion` and `non_fast_forward`** stop `main` being deleted or rewritten.
- **`pull_request` with 0 approvals, and code owner review required.**
  GitHub does not let anyone approve their own pull request, so on a
  single-maintainer repository one required approval for *every* pull request
  would mean the owner's own pull requests could never merge. 0 approvals
  still makes every change arrive as a pull request that passed the required
  checks. Code owner review is what puts the owner in the loop where it
  matters: [`.github/CODEOWNERS`](../.github/CODEOWNERS) lists only the Tier 1
  and Tier 2 paths ([risk-tiers.md](risk-tiers.md)), so a pull request that
  touches one of them cannot merge, by anyone or any token, until the owner
  approves it on GitHub. That approval is then on record. A Tier 3 pull
  request touches no listed path and merges on the required checks alone.
  CODEOWNERS has no catch-all `*` line for that reason, and
  `scripts/check-policies.mjs` fails if one comes back.

  The cost: the owner is the only code owner, and cannot approve their own
  pull request, so a pull request the owner opens that touches a Tier 1 or
  Tier 2 path cannot merge either. Either have an agent open it and approve
  that, or add a bypass for the admin role in `pull_request` mode
  (`{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode":
  "pull_request"}` in `bypass_actors`). That bypass lets an admin merge a
  pull request past *all* of its rules, required checks included, so it is
  not in the file by default.
- **Seven required checks**, all GitHub Actions (`integration_id` 15368):
  - `Lint`, `Unit tests (debian 12)`, `Unit tests (debian 13)` and
    `E2E (debian container)`: the jobs in
    [`ci.yml`](../.github/workflows/ci.yml).
  - `Coverage gate`: the job in
    [`coverage-gate.yml`](../.github/workflows/coverage-gate.yml).
  - `policy-check`: the job in
    [`policy-check.yml`](../.github/workflows/policy-check.yml), which runs
    `scripts/check-policies.mjs` and its tests.
  - `agent-tooling`: the job in
    [`agent-tooling.yml`](../.github/workflows/agent-tooling.yml), which runs
    the Bash guard hook's tests and validates `.claude/settings.json`.

  All four workflows run on every pull request to `main` with no path
  filter, so no pull request waits for a check that never starts. Renaming a
  job (its `name:`), or adding a path filter, blocks every merge until this
  file and the live ruleset are updated to match; see "Renaming a required
  check".
- **A pull request merges only with `main`'s current head in it**
  (`strict_required_status_checks_policy: true`). The required checks have
  then run on what will land, not on a stale base.

## Merge queue (issue #42)

GitHub's merge queue is offered only to repositories owned by an organization,
and this one is under a personal account, so the ruleset has no `merge_queue`
rule. The same guarantee comes from two pieces together:

1. The up-to-date rule above: every pull request carries `main`'s current head
   and has passed the seven checks on it.
2. Hive's serialized merge lane (`merge_strategy: hive-serialized`): Hive merges
   one pull request at a time and re-validates the next one against the new
   `main`, so two agent pull requests that pass on their own cannot break
   `main` together.

The ACMM evaluation credits its Merge queue criterion when both hold. The Hive
side is a setting on the Hive dashboard (ACMM evaluation, Merge queue row for
`dns-failover`, **Use serialized merge lane**), not a file in this
repository. The owner switched it on on 2026-10-11; Hive's fleet status read
back `mergeStrategy: hive-serialized` for `Danathar/dns-failover` on
2026-10-12. To re-check, make an authenticated
`GET /api/repos/merge-strategy?repo=dns-failover` on the Hive dashboard API.

## Applying or changing the ruleset

A pull request cannot change repository settings; a repository admin applies
the file. First time:

```bash
gh api --method POST repos/Danathar/dns-failover/rulesets \
  --input .github/rulesets/main.json
```

To change it, edit the file in a pull request, then after it merges update
the live ruleset from the file:

```bash
gh api --method PUT repos/Danathar/dns-failover/rulesets/24900573 \
  --input .github/rulesets/main.json
```

### Renaming a required check

That order deadlocks when a pull request renames a required job: the pull
request reports only the new name while the live ruleset waits for the old
one, so it can never merge. Stage it instead:

1. Open the pull request that renames the job and changes
   `.github/rulesets/main.json` to the new name. Wait for its new check to pass.
2. While it is open, PUT the file from that branch to the live ruleset (the
   command above, run in a checkout of the branch). The pull request can now
   merge on its new check.
3. Merge it, then run the diff above against `main` to confirm the live rules
   and the file agree.

No other pull request can merge between steps 2 and 3: until the rename is on
`main`, their CI still reports the old name. Do step 3 straight after step 2;
after it, each open pull request merges `main` and needs one CI run, which the
up-to-date rule requires anyway.

## When there is a second reviewer

Add them to the Tier 1 and Tier 2 entries in CODEOWNERS, so either can approve
the other's pull requests. Then consider `required_approving_review_count` 1,
and `require_last_push_approval`, so a push after approval needs a fresh one.
