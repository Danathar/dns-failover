# Auto-restore turns override back on only if the monitor turned it off

**Date:** 2026-10-11
**Wrong:** making the monitor re-enable "Override DNS servers" whenever
ControlD is healthy, or enabling `auto_restore` by default.
**Right:** in `tick` (`tailscale-dns-failover/monitor.py`) restoration needs all
of: `config['auto_restore']` true (the setup default is false), a saved
`restore_config` (written before the POST, only when the monitor itself found
override enabled and disabled it), 300 s of `healthy_since`, override still off,
and a current configuration equal to the saved one apart from `overrideLocalDNS`
(`without_override`). If an administrator changed anything else, the saved
baseline is dropped and the message says restoration was canceled. A manual
"off" is never auto-enabled. `update` re-reads the configuration before a PUT
and again after, and raises if either differs.
**Why it matters:** the setting is tailnet-wide. Re-enabling it over an
administrator's deliberate change, or overwriting their other DNS edits with a
stale copy, breaks DNS for every device.
**Evidence:** `tick`, `update`, `without_override` in
`tailscale-dns-failover/monitor.py`; tests `test_default_does_not_restore`,
`test_manual_off_never_auto_enabled`, `test_changed_configuration_cancels_recovery`
and `test_intervening_admin_edit_is_not_overwritten` in
`tailscale-dns-failover/test_monitor.py`; README "auto_restore".
