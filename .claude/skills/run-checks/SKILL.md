---
name: run-checks
description: Run dns-failover's tests and static analysis (pytest, ruff, shellcheck, optionally e2e and policy checks) before committing or opening a PR.
---

# run-checks

From the repo root (use absolute paths or `git -C`, not `cd`):

```bash
python3 -m pytest
ruff check .
git ls-files '*.sh' | xargs shellcheck
```

Also, when relevant:

- Installer, unit file, dnsmasq or Stubby config changed: `tests/e2e/run.sh`
  (needs podman or docker; runs in a throwaway container).
- Product code changed: `python3 -m coverage run -m pytest && python3 -m coverage report`.
- Agent docs, policies or workflows changed: `node scripts/check-policies.mjs`.
- `scripts/` or `.claude/hooks/` changed: `node --test 'scripts/tests/*.test.mjs'` and
  `node --test '.claude/hooks/tests/*.test.mjs'`.

Any `gh` write command: pass `--repo Danathar/dns-failover`.

Report the exact commands and observed results; these are the same checks as
the jobs in `.github/workflows/`. If a tool is missing, say so. Never
substitute running an installer or monitor on the host (see the host rule in
`AGENTS.md`).
