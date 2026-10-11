## Summary

<!-- What changed and why. Closes #N -->

## Risk tier

<!-- Highest tier touched, see docs/risk-tiers.md: 1 critical, 2 high, 3 standard. -->

- [ ] Tier 1 (workflows, hooks, policies, installers, configure.py, monitor.py, dns-upstream-check.py, AGENTS.md, LICENSE)
- [ ] Tier 2 (probe, units, dnsmasq/Stubby configs, pyproject.toml, agent files, skills, memory)
- [ ] Tier 3 (tests, other docs and scripts)

## Checks run

<!-- Paste the exact commands and observed results. -->

- [ ] `python3 -m pytest`
- [ ] `ruff check .`
- [ ] `git ls-files '*.sh' | xargs shellcheck`
- [ ] `tests/e2e/run.sh` (required if an installer, unit file or dnsmasq/Stubby config changed)
- [ ] `python3 -m coverage run -m pytest && python3 -m coverage report` (if product code changed)
- [ ] `node scripts/check-policies.mjs` (if agent docs, policies or workflows changed)
- [ ] `node --test scripts/tests/` and `node --test .claude/hooks/tests/` (if scripts or hooks changed)
- [ ] Added/updated a test for each behaviour change
- [ ] README updated if behaviour or configuration changed

## Host rule

- [ ] I did not run `sudo`, either installer, `configure.py`, `monitor.py` (including `--dry-run`), `dns-upstream-check.py` on real paths or without `--no-reload`, `systemctl`/`service` on dnsmasq/stubby/the units, or any Tailscale API call
- [ ] No credentials, ControlD profile IDs, addresses, hostnames or tailnet names added
- [ ] Failover safety behaviour (atomic writes, PID check, restore on failed install, 3-failure threshold, `auto_restore` default) unchanged, or the change is called out below

## Not verified

<!-- Anything you could not test (e.g. real ControlD outage, live Tailscale API). -->

## AI assistance

- [ ] This PR was prepared with AI assistance (name the tool), or
- [ ] No AI assistance was used
