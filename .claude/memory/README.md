# Correction memory

One file per correction: a mistake an agent made, or nearly made, in this
repository, the rule that prevents it, and the evidence. The conversation that
produced a mistake is gone by the next session; these files are what is left.

**Host rule.** This repository is the source of a live DNS server's failover
setup. Agents never run, on the host: `sudo`; either installer
(`install-dns-failover.sh`, `tailscale-dns-failover/install.sh`);
`tailscale-dns-failover/configure.py`; `tailscale-dns-failover/monitor.py` in any
mode (`--dry-run` and `--status` call the live Tailscale API with real
credentials); `dns-upstream-check.py` against real paths or without
`--no-reload`; `systemctl`/`service` actions on dnsmasq, stubby or the units; or
any Tailscale API call. Exercise code with `python3 -m pytest` (fakes, temp
dirs) and `tests/e2e/run.sh` (throwaway container).
`.claude/hooks/guard-bash.mjs` enforces this. Pull requests, issues and
comments go to `Danathar/dns-failover` (`--repo Danathar/dns-failover`).

## What goes here

- Something an agent got wrong, or came within one step of getting wrong, that
  is easy to repeat and hard to see from the code alone.
- Not here: standing rules that apply to all work (those are in
  [AGENTS.md](../../AGENTS.md)), what is in flight right now (that is
  [../session-summary.md](../session-summary.md)), and patterns in how the
  work goes (those are [../../docs/reflections/](../../docs/reflections/README.md)).
  A correction that hardens into a standing rule is promoted to AGENTS.md; the
  entry stays as the reason behind the rule.

## Naming and format

`<kebab-case-topic>.md`, one correction per file, in this shape:

```markdown
# <short title>

**Date:** YYYY-MM-DD (when it was recorded)
**Wrong:** what was done or assumed
**Right:** what is true / what to do
**Why it matters:** the consequence of repeating it
**Evidence:** file and function/symbol, test name, commit or PR
```

Evidence must be something a reader can open. A claim that cannot be checked
against a commit, a PR or a file does not get an entry. Cite code by function
or symbol name (`tick` in `tailscale-dns-failover/monitor.py`), never by bare
line number: lines drift on the next edit.

## When to add and retire

- Add an entry in the same PR that fixes the mistake, or at the end of the
  session in which it was caught. Check the index below first and extend an
  existing entry rather than adding a near-duplicate.
- Re-verify an entry before relying on it. If it is no longer true (for
  example the three-check rule changed), delete or rewrite the file in the PR
  that makes it untrue. A stale correction is worse than none.
- Add the new file to the index below.

## Index

| Entry | One line |
|---|---|
| [never-run-monitor-on-host](never-run-monitor-on-host.md) | `monitor.py --dry-run` is not a dry run of the API: it authenticates and reads the live tailnet DNS configuration |
| [hysteresis-is-three-checks](hysteresis-is-three-checks.md) | Switch to backup after one failed primary check; return after three healthy ones; the Tailscale monitor needs three failures. Do not "simplify" the asymmetry |
| [atomic-write-then-sighup](atomic-write-then-sighup.md) | The upstream file is replaced atomically, then dnsmasq is signalled only after its PID file is checked against `/proc/<pid>/comm`; a failed signal is retried |
| [auto-restore-only-after-own-disable](auto-restore-only-after-own-disable.md) | The monitor turns tailnet DNS override back on only if it turned it off, `auto_restore` is true, and the configuration is unchanged |
| [keep-site-specifics-out](keep-site-specifics-out.md) | No ControlD profile IDs, LAN addresses, tailnet names or credentials in this public repository, including tests and docs |
