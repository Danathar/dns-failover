# Agent boundaries

What an AI agent may change on its own in this repository, and what needs the
owner (Danathar). It maps the tiers in [docs/risk-tiers.md](risk-tiers.md) to
the owners in [`.github/CODEOWNERS`](../.github/CODEOWNERS), and complements
`AGENTS.md` and the [AI security policy](security/SECURITY-AI.md).

Agents open pull requests against `Danathar/dns-failover` only
(`--repo Danathar/dns-failover` on every `gh` write command).

## By tier

| Tier | Agent may | Agent may not |
| ---- | --------- | ------------- |
| 1 critical | Propose a change in a pull request when the owner asked for it, and run the required commands. | Merge it, change it as part of unrelated work, or edit files that bound agents (`AGENTS.md`, `policies/`, `risk-config.json`, `renovate.json`, `.github/CODEOWNERS`, `.github/workflows/`) at all unless the owner told it to. |
| 2 high | Open a pull request with the required commands run and reported. | Merge it. The owner reads the diff. |
| 3 standard | Open a pull request; the required CI jobs are the gate. | Skip or loosen a failing check, or use a docs-only change to hide a change to a command users run as root. |

Tier is by what the change can break, and the highest tier any touched path
matches applies, raised by the rules in "Raise the tier" in
[risk-tiers.md](risk-tiers.md). `node scripts/check-policies.mjs --classify
<path>...` prints the tier of a path but cannot see inside a file.

## Who owns what

`.github/CODEOWNERS` lists the Tier 1 and Tier 2 paths with `@Danathar`, and
nothing else: there is no catch-all `*`. `node scripts/check-policies.mjs`
fails when a path of a tier that needs owner review is missing there, or when
a `*` entry is added. The ruleset in `.github/rulesets/main.json` requires code
owner review, so once it is applied (see
[branch-protection.md](branch-protection.md)), a pull request touching a Tier 1
or Tier 2 path cannot merge until the owner approves it on GitHub, whoever or
whatever performs the merge. Tier 3 merges on the required checks.

## Always off limits

These need the owner's explicit instruction in the conversation, whatever the
tier. The first group is the host rule: it holds on any machine that runs the
real DNS server, and an agent's own machine counts.

- `sudo`, in any form.
- Running `install-dns-failover.sh` or `tailscale-dns-failover/install.sh`,
  or `tailscale-dns-failover/configure.py`.
- Running `tailscale-dns-failover/monitor.py` in any mode. `--dry-run` is not
  safe: it still uses real credentials against the live Tailscale API.
- Running `dns-upstream-check.py` against real paths (`/run/...`, the real
  dnsmasq PID file) or without `--no-reload`.
- `systemctl` or `service` actions on dnsmasq, stubby or this project's units.
- Any Tailscale API call.
- Reading, printing or committing credentials, `/root/.config/...`, tokens,
  `.env` files, or site-specific values: ControlD profile IDs, LAN addresses,
  hostnames, tailnet names ([SECURITY-AI.md](security/SECURITY-AI.md)).
- Editing `LICENSE`.
- Repository settings, rulesets, labels, secrets, branch protection.
- Merging, approving, or force-pushing.
- Posting anywhere other than `Danathar/dns-failover`.

Code is exercised only through the unit tests (fakes, stubs, temp dirs) and
the end-to-end test inside a throwaway container (`tests/e2e/run.sh`).

## Files that bound agents

Changing these relaxes the agent boundary itself, so a green CI run is not
enough and the owner reads the diff:

- `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/`,
  `.github/prompts/`, `.claude/skills/`, `.claude/memory/`
- `.claude/settings.json` and `.claude/hooks/` (the permission table and the
  Bash guard that enforces the host rule)
- `policies/`, `scripts/check-policies.mjs`, `risk-config.json`, `renovate.json`,
  `.github/CODEOWNERS`, `.github/workflows/`
- `docs/security/`, `docs/risk-tiers.md`, this file (Tier 2)

`policies/repo-target.json` lists the direction files that must carry
`--repo Danathar/dns-failover`. Add a new one there when you add a new kind of
agent instruction file.
