# The failover thresholds are deliberately asymmetric

**Date:** 2026-10-11
**Wrong:** "tidying" the switch logic so failover and failback use the same
count, or making one failed check enough in the Tailscale monitor.
**Right:** there are two mechanisms with different thresholds:

- `dns-upstream-check.py` (every ~5 s, `dns-upstream-check.timer`): a primary
  check passes if either probe domain answers (`healthy` uses `any`). After one
  failed primary check, `main` switches to the backup if the backup answers.
  It returns to the primary only after `primary_successes` reaches 3. If both
  fail it keeps the current selection and prints that it did.
- `tailscale-dns-failover/monitor.py` (every ~20 s): `tick` counts `failures`
  and does nothing until it reaches 3 and the local backup answers. Restoring
  needs 300 s of continuous health (`healthy_since`), only with
  `auto_restore`. A gap longer than 90 s (or a clock going backwards) resets
  both streaks, so a reboot does not count as three failures.

Fast to leave the broken path, slow to return, and the tailnet-wide change
slower than the local one. A test that changes a threshold must change the
README ("Returns to primary after three healthy checks", the failover table) in
the same PR.
**Why it matters:** equal thresholds make dnsmasq flap between upstreams on a
flaky primary; a single failure in the monitor would switch off tailnet DNS
override for every device on a blip.
**Evidence:** `main` and `healthy` in `dns-upstream-check.py`; `tick` in
`tailscale-dns-failover/monitor.py`; tests `test_intermittent_failure_does_not_trigger`,
`test_long_pause_resets_failure_streak` and `test_opt_in_restore_requires_five_minutes`
in `tailscale-dns-failover/test_monitor.py`; README table "Tailscale ... 3
consecutive failures".
