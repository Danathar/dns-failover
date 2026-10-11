# PR review rubric

How changes to this repository (`Danathar/dns-failover`) get reviewed. Written
for the owner, for agents reviewing, and for agents checking their own work
before opening a PR. The product runs as root on a DNS server that a whole
household or tailnet depends on: a Python health checker
([`dns-upstream-check.py`](../dns-upstream-check.py)) that rewrites dnsmasq's
upstream every few seconds and signals dnsmasq, a Tailscale monitor
([`tailscale-dns-failover/monitor.py`](../tailscale-dns-failover/monitor.py))
that edits the tailnet's DNS settings through the Tailscale API, and POSIX
installers that rewrite `/etc/dnsmasq.conf`. A mistake here does not show up
as a failed page; it shows up as a network with no DNS, a tailnet pointed at a
dead resolver, or a root-owned file that was half written.

Review in this order. The first section that fails is the one to fix. Where
this page and [AGENTS.md](../AGENTS.md) disagree, AGENTS.md wins.

## Severity levels

Review findings use the four levels the Codex connector
(`chatgpt-codex-connector[bot]`) can attach to its comments as `P0`-`P3`
badges, so a human, an agent and Codex all describe a finding the same way.
Codex findings are advisory: verify each against the code before acting, reply
with the reasoning, and resolve the thread either way.

| level | meaning | merge? |
|---|---|---|
| P0 | A secret or site-specific value (OAuth client secret, ControlD profile id, LAN address, tailnet name) enters the repo or a log; the host rule is bypassed (a script or hook change that lets an agent run an installer, `monitor.py` or the live API); the monitor takes over a tailnet DNS setting it does not own; a licence violation | Never. Fix first, even if CI is green |
| P1 | Wrong failover behaviour a user will hit: switching to a backup that was not checked, never returning to the primary, flapping, changing the selection when both paths fail, a reload sent to the wrong process, a half-written `servers.conf` or `state.json`, an installer that leaves a broken `/etc/dnsmasq.conf` without restoring the backup, a systemd unit that never runs or runs the wrong command | Not until fixed, or the owner accepts the risk in the PR thread |
| P2 | Real but narrow: a missing test for an error path, a failure reported with the wrong message, a temp file not cleaned up on one path, a flag documented but not honoured | Fix in the PR, or reply with why it does not apply and resolve the thread |
| P3 | Style, naming, comment wording, documentation phrasing | Optional; do not block on it |

## 1. Scope, tier and the host rule

- [ ] **One concern per PR**, sized to the problem. A bug fix does not reformat
      a product file.
- [ ] **Risk tier.** Find the tier of the paths touched in
      [risk-tiers.md](risk-tiers.md) and review at that depth: the more
      sensitive the path, the more of sections 2-7 apply and the less a green
      CI is worth by itself. Tier 1 paths (workflows, the hook and its
      settings, `policies/`, the installers, `configure.py`, `monitor.py`,
      `dns-upstream-check.py`) need the owner's review and every check.
      Agent limits per path are in [agent-boundaries.md](agent-boundaries.md).
- [ ] **Host rule.** Nothing in the diff, the tests or the PR body runs, on
      the host, `sudo`, either installer, `configure.py`, `monitor.py` in any
      mode (`--dry-run` still uses real credentials against the live
      Tailscale API), `dns-upstream-check.py` against real paths or without
      `--no-reload`, `systemctl`/`service` on dnsmasq, stubby or the units, or
      any Tailscale API call. The test plan uses the unit tests (fakes, temp
      directories) and `tests/e2e/run.sh` (a throwaway container).
- [ ] **Licence.** `LICENSE` (GPL-3.0-or-later) is untouched and the README
      licence statement stays; copied-in code carries a compatible licence.

## 2. Failover correctness: `dns-upstream-check.py`

The checker picks the upstream dnsmasq uses. It runs from a timer every few
seconds, so a logic slip repeats quickly.

- [ ] **Hysteresis is intact.** One failed primary check switches to the
      backup (when the backup answers); the primary comes back only after
      three consecutive healthy checks (`primary_successes`). A change must
      keep both numbers, keep the counter reset to zero on a failed primary
      check, and keep it capped so it cannot grow without bound. A test must
      show the exact sequence, not only the end state.
- [ ] **Both paths down keeps the selection.** When the primary and the backup
      both fail, the current selection is retained (and the first-ever run
      with no file falls back to the primary). Switching to a resolver that
      just failed its check, or to an empty selection, is P1.
- [ ] **Health means an answer.** `healthy()` requires `NOERROR` and a real
      `A` record (not `0.0.0.0`, which is how a blocking resolver says no) and
      passes if either probe domain works, so one broken domain does not
      cause a failover. Loosening it (any exit code zero, matching a
      `SERVFAIL` body) or tightening it to require both domains is a
      behaviour change that needs its own test and an explanation.
- [ ] **Writes are atomic.** `servers.conf` and `state.json` are written to a
      temp file in the same directory and `replace()`d, never written in
      place: dnsmasq may re-read `servers.conf` on a SIGHUP at any instant, and
      a truncated file means no upstream. New files the checker writes follow
      the same rule.
- [ ] **dnsmasq is verified before it is signalled.** The PID file is read, and
      `/proc/<pid>/comm` must say `dnsmasq` before `SIGHUP` is sent; a stale
      PID file that now names another process must raise, not signal it. A
      missing PID file is not an error (dnsmasq is not running yet).
- [ ] **A failed reload is retried.** If the signal fails after the selection
      changed, `reload_pending` is persisted and the failure is surfaced
      (non-zero exit), so the next timer run retries. A change that swallows
      the error or forgets to persist the flag leaves dnsmasq on the old
      upstream until the next flip.
- [ ] **Paths and ports stay arguments.** `--directory`, `--pid-file`,
      `--primary-port`, `--backup-port` and `--no-reload` are what let tests
      run against a temp directory; do not hard-code a real path where an
      argument exists.
- [ ] **Python 3.11 and stdlib only.** Debian 12 ships Python 3.11; a new
      import must come from the standard library.

## 3. Tailscale override ownership: `monitor.py` and `configure.py`

The monitor edits one setting of a tailnet-wide DNS configuration it shares
with the owner and with the Tailscale admin console.

- [ ] **Three failures, and the backup answers.** The override is turned off
      only after three consecutive primary failures **and** a working local
      backup; a first failure, or a failed backup, does nothing.
- [ ] **Ownership is recorded before the change.** `restore_config` is saved
      and persisted before the API write, because the write can succeed even
      if its response is lost. Only a configuration the monitor itself
      disabled may be restored.
- [ ] **`auto_restore` is off by default** and restores only after five
      healthy minutes. It must not restore when the override is already on
      (someone else did it) or when the live configuration, apart from
      `overrideLocalDNS`, differs from the saved one (someone edited it):
      those cancel the restoration. Any new "restore" path keeps both guards.
- [ ] **No blind writes.** Before an update the configuration is re-read and
      must equal what the decision was based on, and after it the result is
      read back and verified. The expected resolver id is checked before any
      change (`check_profile`), so the monitor never edits a tailnet that is
      not the one it was configured for.
- [ ] **Retries are rate-limited and streaks reset.** `next_api_attempt` limits
      API calls during a long outage; a reboot, a long gap or a clock jump
      resets the failure and healthy streaks. Removing either is P1.
- [ ] **Credentials.** `configure.py` writes the root-only config
      (`/root/.config/tailscale-dns-failover/config.json`), refuses to
      overwrite it, and never echoes the secret; `monitor.py` never prints it.
      Fixtures and tests use obviously fake values.
- [ ] **No live API in tests.** Tests drive `tick()` and the `Client` through
      fake responses; nothing opens a real connection, and `--dry-run` is not
      treated as safe (it calls the live API).

## 4. Installers and units: rollback and privilege

[`install-dns-failover.sh`](../install-dns-failover.sh) and
[`tailscale-dns-failover/install.sh`](../tailscale-dns-failover/install.sh)
run as root against a live server. Nobody but the owner runs them.

- [ ] **`set -eu` stays**, and expansions are quoted.
- [ ] **A backup exists before the first overwrite**, outside `/etc`, owned by
      root with mode `0700`, and it is created once (an existing backup is not
      replaced by an already-modified file).
- [ ] **The new `dnsmasq.conf` is validated before it is installed**
      (`dnsmasq --test`) **and after** (`systemd-helper checkconfig`); if the
      post-install check or the restart fails, the backup is restored and the
      installer exits non-zero. A new step that can fail after the config is
      installed must be inside that rollback, or itself restore the backup.
- [ ] **Units are verified** with `systemd-analyze verify` before they are
      enabled, and the installer finishes by confirming the services are
      active.
- [ ] **Modes and ownership.** Executables are installed `0755`, configs
      `0644`, and anything holding credentials `0600` root-only. A change that
      widens a mode is P1.
- [ ] **Units.** `*.service` files keep a working `ExecStart=` and the intended
      `Type=`; `*.timer` files keep `[Install] WantedBy=timers.target` and an
      interval that matches the documented one (the checker every few
      seconds, the monitor about every 20 seconds). A new unit with network or
      `/run` access is reviewed for what it can reach.
- [ ] README install instructions match the file names and paths in the diff.

## 5. Secrets and site-specific values

The README says the site specifics were removed for sharing; keep it true.

- [ ] No OAuth client id or secret, API token, ControlD profile id, real LAN
      or tailnet address, hostname, tailnet name or e-mail address in code,
      tests, fixtures, docs, workflow files, logs or the PR text.
- [ ] Example configs (`*.example`, `dnsmasq-*.conf`, `stubby-*.yml`) use
      placeholders that are visibly not real (`<your-profile-id>`,
      documentation addresses).
- [ ] Nothing in the diff reads a credential file for a test; tests build
      their own temp config.

## 6. Tests

- [ ] New behaviour has a test that fails without the change, and a bug fix
      includes the test that would have caught it. Unit tests are Python
      under `tests/unit/` (plus the existing
      `tailscale-dns-failover/test_monitor.py`), using fakes and temp
      directories; the container end-to-end test is under `tests/e2e/`. The
      jobs that run them are in
      [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
- [ ] Tests check observable outcomes (which `servers.conf` was written, what
      `state.json` holds, whether `SIGHUP` was sent and to which pid, which
      API calls were made and with what body), not that a function ran.
- [ ] The failure paths are exercised: primary down and backup up, both down,
      primary back after fewer than three and after three healthy checks,
      stale PID file, reload failure then retry, API configuration changed
      mid-update, restoration cancelled by an external edit, installer
      post-install failure restoring the backup.
- [ ] `ruff check .` and `shellcheck` are clean without new blanket ignores or
      `# shellcheck disable`. Ruff is not used to reformat product code.
- [ ] Coverage does not drop below the floor in `pyproject.toml`; lowering the
      floor needs the owner.
- [ ] CI is green **and the branch is current with `main`**. A green run on a
      stale branch says little about the merge result. See
      [quality.md](quality.md) for how to read each job.

## 7. Housekeeping

- [ ] Commits follow Conventional Commits; the PR title does too. No
      `Signed-off-by` trailers unless the owner asked.
- [ ] Docs changed with behaviour: the README, and `AGENTS.md`/`CLAUDE.md` if
      a rule or command changed. Code is cited by function or symbol name,
      never by bare line number.
- [ ] Workflows: top-level `permissions:` read-only (write scopes only on the
      job that needs them), third-party actions (anything outside `actions/*`
      and `github/*`) pinned to a full commit SHA with a `# vX` comment,
      event-controlled strings passed through `env:` rather than interpolated
      into `run:`, no `pull_request_target`, no Docker Hub images. A workflow
      that calls `gh` sets `GH_REPO: ${{ github.repository }}` and passes
      `--repo "$GH_REPO"`. Every `gh` write command in a Markdown file carries
      `--repo Danathar/dns-failover`.
- [ ] No generated or local files committed (`.env`, credentials, state files,
      scratch directories).

## Reviewing agent PRs (Hive and others)

- The agent's own report is a claim, not evidence. Check the commands it says
  it ran against the CI result and the diff.
- Hive PRs end with a signature line (`— hive: agent=<name>`); the author is
  `app/danathar-atomic-hive`. They get the same rubric as a human PR, and
  their outcomes are the "Hive app" row of [metrics.md](metrics.md).
- A PR that widens what an agent may do (workflows, `.claude/settings.json`,
  hooks, rulesets, the host rule) is reviewed at the highest tier whatever its
  size.
- Do not push to a contributor's branch to fix it; comment instead.
