# Replace the upstream file atomically; signal dnsmasq only after checking its PID

**Date:** 2026-10-11
**Wrong:** writing `servers.conf` in place, signalling whatever PID the file
holds, or dropping the retry so a lost signal leaves dnsmasq on the old upstream.
**Right:** `dns-upstream-check.py` writes `servers.conf` and `state.json`
through `atomic_write` (a `.tmp` sibling, mode 0644, then `Path.replace`), so
dnsmasq never reads a half-written file. Then, unless `--no-reload`, `main`
reads the PID file, requires `/proc/<pid>/comm` to be `dnsmasq`, and only then
sends `SIGHUP`. If the signal fails after the file changed, `main` records
`reload_pending` in `state.json` and re-raises, so the next run (5 s later)
retries. Keep all three: atomic replace, identity check, pending flag. Tests use
`--no-reload` with a temp `--directory`; nothing in a test sends a signal to a
real process.
**Why it matters:** a torn file leaves dnsmasq with no upstream; a stale PID
file can make the checker signal an unrelated process; a missing retry leaves
DNS on a dead upstream until the next state change.
**Evidence:** `atomic_write` and `main` in `dns-upstream-check.py`;
`.claude/hooks/guard-bash.mjs` (`checkUpstreamCheck` allows the script only
with `--no-reload`, `--directory` and `--pid-file` inside scratch space).
