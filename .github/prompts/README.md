# Prompt catalog

Reusable prompt files for Copilot Chat / VS Code (`.prompt.md`); the content
works as a plain prompt in any other tool. All of them assume the rules in
[AGENTS.md](../../AGENTS.md), most importantly the host rule: never run
`sudo`, the installers, `configure.py`, `monitor.py` (even `--dry-run`),
`dns-upstream-check.py` on real paths, `systemctl` on the DNS services, or any
Tailscale API call. Any `gh` write command passes `--repo Danathar/dns-failover`.

| Prompt | Use it when |
|---|---|
| [change-health-check.prompt.md](change-health-check.prompt.md) | Changing how or how often either monitor decides an upstream is healthy (domains, thresholds, intervals) |
| [add-upstream-provider.prompt.md](add-upstream-provider.prompt.md) | Adding or replacing a DNS-over-TLS provider (a new Stubby listener, probe target or backup) |
| [tailscale-api-change.prompt.md](tailscale-api-change.prompt.md) | The Tailscale DNS API changes shape or `monitor.py` misreads it |
| [review-pr.prompt.md](review-pr.prompt.md) | Reviewing a PR against this repo's safety rules |

Add a new prompt as `<verb-noun>.prompt.md` with a `description` in the
frontmatter and a row in the table above.
