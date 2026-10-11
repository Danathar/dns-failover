# Agent task traceability

How to start from an agent's change in `Danathar/dns-failover` and find the task
that produced it, and how this directory records that going forward. Rules for
agents are in [`AGENTS.md`](../../AGENTS.md); how several agents share the
repository is in [`multi-agent.md`](../multi-agent.md).

Every `gh` command here passes `--repo Danathar/dns-failover`.

## What a ledger is

One file per day or working session, named `YYYY-MM-DD.md` (add `-2`, `-3` for a
second session on the same day). It lists, for each task:

| column | meaning |
|---|---|
| issue | the GitHub issue the work answers, `#N` |
| branch | the branch the work was done on |
| PR | the pull request number once one exists; `-` before that. Never guess one |
| outcome | `open`, `merged`, `closed unmerged`, `abandoned`, with the reason if not `merged` |
| agent | who did it: a Hive agent (`agent=<name>` from the signature line), a workflow, or a local session (tool and model) |
| Hive run | the link to the Hive run if Hive did the work, or `none` |

A ledger is a record of what was planned and what happened on that date. Add
rows and fill in PR and outcome as they become known. Do not rewrite history in
it; if a later fact contradicts a row, add a dated note under the table. Each
issue appears in exactly one row of a ledger.

## Following one change end to end

```text
file --git blame--> commit --gh api repos/Danathar/dns-failover/commits/<sha>/pulls--> PR
PR --Closes #N--> issue (the task statement)
PR --signature line / author--> agent
issue/branch/PR --this directory--> the ledger row
```

The marks a change carries, and where to read them:

- **Closing reference.** A pull request body contains `Closes #N`:

  ```bash
  gh pr view <N> --repo Danathar/dns-failover --json closingIssuesReferences \
    --jq '[.closingIssuesReferences[].number]'
  ```

- **Hive signature.** Hive PRs end with a line like `— hive: agent=<name>` and
  are opened by `app/danathar-atomic-hive`:

  ```bash
  gh pr view <N> --repo Danathar/dns-failover --json author,body \
    --jq '.author.login, (.body | split("\n") | map(select(startswith("— hive: "))))'
  ```

  A PR the owner opened from a local session carries the owner's login and may
  carry no signature; do not read "unsigned" as "human-written".
- **Branch name.** The ACMM effort used `acmm/<slug>`; Hive names its own
  branches. A branch survives its deletion in the PR record:

  ```bash
  gh pr list --repo Danathar/dns-failover --state all --head <branch> --json number,state,mergedAt
  ```

- **Merge commits.** `git log origin/main --first-parent --merges --grep='<branch>'`.
- **Audit.** `.github/workflows/agent-audit.yml` reports which agent PRs lack a
  closing reference, a signature, or a merger that is neither a human nor the
  Hive serialized lane.

None of these is enforced for every change. A mark can be missing; the ledger is
how the gap is closed by hand.

## Ledgers

- [2026-10-11](2026-10-11.md): the ACMM issues #1 to #50.
