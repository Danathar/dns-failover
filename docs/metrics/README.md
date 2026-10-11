# Published metrics

Dated, committed readings of the PR metrics defined in
[`docs/metrics.md`](../metrics.md). The repository is public, so these files
are the public record of how its pull-request flow is going. Each file is left
as it was read; for current values rerun the script or open the latest
`pr-metrics` artifact of the
[weekly workflow](https://github.com/Danathar/dns-failover/actions/workflows/pr-metrics.yml).

| date | file |
|---|---|
| 2026-10-11 | [snapshot](2026-10-11.md), input [`2026-10-11.prs.json`](2026-10-11.prs.json) |

## Adding a snapshot

Snapshots are made by hand, not by the workflow (Actions never commits here).
The `gh` call names the repository explicitly so it reads the same data from
any clone.

```bash
DATE=$(date -u +%F)
NOW=$(date -u +%FT%TZ)
gh pr list --repo Danathar/dns-failover --state all --limit 500 \
  --json number,author,state,createdAt,mergedAt,closedAt,labels,title \
  > docs/metrics/$DATE.prs.json
node scripts/pr-metrics.mjs --input docs/metrics/$DATE.prs.json --now "$NOW"
```

Put the output in `docs/metrics/$DATE.md` under a header that states the exact
commands, the `--now` value and the `main` commit at the time. Commit the input
JSON beside it so the numbers can be reproduced with
`node scripts/pr-metrics.mjs --input docs/metrics/<date>.prs.json --now <the same time>`.
Add a row to the table above. Snapshots contain only PR numbers, titles,
author logins and timestamps; they never contain credentials or site-specific
values.
