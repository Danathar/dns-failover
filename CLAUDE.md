# CLAUDE.md

@AGENTS.md

## Claude Code notes

- `AGENTS.md` is the source of truth; keep this file short.
- **Host rule:** never run `sudo`, either installer, `configure.py`, `monitor.py`
  (even `--dry-run`: it calls the live Tailscale API), `dns-upstream-check.py`
  against real paths or without `--no-reload`, `systemctl`/`service` on
  dnsmasq, stubby or the units, or any Tailscale API call. Use the unit tests
  and `tests/e2e/run.sh`.
- Skills in `.claude/skills/`: `run-checks`, `test-failover-in-container`,
  `handle-tailscale-api-change`.
- Use `git -C <dir>`/absolute paths rather than `cd`, and `/var/tmp/` rather
  than `/tmp` for scratch files.
- Any `gh` write command: pass `--repo Danathar/dns-failover`.
- Read `.claude/session-summary.md` at the start of a session. Follow its
  end-of-session rule: only the session landing work on `main` rewrites it;
  otherwise put handoff notes in the PR body.
