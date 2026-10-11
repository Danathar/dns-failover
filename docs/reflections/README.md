# Reflections

A reflection is a dated, short account of how a piece of work in this
repository actually went, and what to do differently next time. It is for
patterns in the work itself, not for facts about the code.

**Host rule.** Agents never run an installer, `configure.py`, `monitor.py` (not
even `--dry-run`: it calls the live Tailscale API), `dns-upstream-check.py`
against real paths, `sudo`, or `systemctl`/`service` on dnsmasq, stubby or the
units on the host. Use `python3 -m pytest` and `tests/e2e/run.sh`. Pull requests
and issues go to `Danathar/dns-failover` (`--repo Danathar/dns-failover`).

## Where things go

| Place | Holds | Lifetime |
|---|---|---|
| [AGENTS.md](../../AGENTS.md) | standing rules | durable |
| [.claude/memory/](../../.claude/memory/README.md) | one specific mistake and its rule | until no longer true |
| [.claude/session-summary.md](../../.claude/session-summary.md) | what is in flight now | overwritten each session |
| this directory | recurring patterns in how the work goes | dated, kept |

Example of the split: "the monitor's `--dry-run` still calls the live API" is a
correction (memory). "A guard written one failing example at a time keeps
leaking; write down what it is for first" is a reflection.

## When to write one

- After a PR where review or CI found something the author's own checks missed.
- After an incident, a revert, or a surprise during a rollout.
- When the same kind of problem has come up twice.

Do not write one for routine work that went as planned.

## Format

File name `YYYY-MM-DD-<topic>.md`. Sections:

```markdown
# <title>

**Date:** YYYY-MM-DD
**Context:** which PRs/issues/commits this is about

## What happened
Observed events only, each with a PR, commit or file reference.

## What it shows
The pattern, stated as narrowly as the evidence allows.

## What to do next time
Concrete practices. If one hardens into a standing rule, move it to AGENTS.md.
```

Rules: no event that cannot be traced to a PR, commit or file; mark guesses as
`[INFERENCE]`; link to the evidence instead of retelling it; delete or amend an
entry that later proves wrong. If a reflection produces a specific do/don't,
also add a correction in `.claude/memory/`. Cite code by function or symbol
name, never by bare line number. PRs and issues in other repositories are
written `Owner/repo#N`.

## Index

| Entry | Subject |
|---|---|
| [2026-10-11-lessons-from-openaudible-autoupdate-followups](2026-10-11-lessons-from-openaudible-autoupdate-followups.md) | What the follow-up issues after the same ACMM rollout on `Danathar/openaudible-autoupdate` taught, applied here before starting |
