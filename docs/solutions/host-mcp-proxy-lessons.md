---
title: Host-MCP proxy — lessons from first end-to-end run
date: 2026-04-26
scope: src/ipc.ts, .claude/skills/host-mcp-agent, container/skills/pitchbook
tags: [host-mcp, sandbox, claude-cli, commander, launchd, docker, sqlite]
status: shipped
---

# Host-MCP proxy — lessons learned

The host-MCP proxy (U1–U8 + Option C sandbox) was built and committed across multiple sessions but never exercised end-to-end until 2026-04-26. The first real pitchbook query exposed five distinct issues — all unrelated to each other, all caught only because the user actually triggered the path. This is the pattern: **infrastructure that ships untested ships broken**, no matter how thorough the unit tests.

Captured here so future-you (or future-anyone) doesn't re-debug them when adding scope #2 or restarting in a fresh environment.

---

## 1. Commander.js variadic flags eat the positional prompt

**Symptom:** Host claude exited in ~700ms with code 1, stderr 132 bytes, no PitchBook tools called. Logs reported "Spawning host-mcp-agent" then "host_mcp_query exit" with no useful detail.

**Root cause:** The claude CLI uses commander.js with several variadic options:

```
--allowedTools, --allowed-tools <tools...>
--disallowedTools, --disallowed-tools <tools...>
--mcp-config <configs...>
--tools <tools...>
```

Variadic in commander = consume every following argv element until the next `--flag`. There is no "next flag" before the positional prompt, so the prompt gets swallowed as another value of whatever variadic preceded it. Reproducible:

```bash
$ claude -p --mcp-config /tmp/x.json "say hello"
Error: Invalid MCP configuration:
MCP config file not found: /tmp/x.json
MCP config file not found: <cwd>/say hello   # ← prompt eaten as a config path
```

**Fix:** Always pass `--` immediately before the positional prompt. T1 in `src/ipc-auth.test.ts` now asserts `argv[argv.length - 2] === '--'` as a regression guard.

**Why this bites later:** Any future scope that adds another flag-array argument will hit this if `--` is omitted. The guard test catches argv-shape changes but does not catch a new variadic flag added downstream of `--`.

---

## 2. `--tools ""` removes Read, breaking file-based protocols

**Symptom:** After fix #1 landed, host claude exited code 0 in ~700ms with stderr message: *"my --allowed-tools allowlist does not include Read (or any filesystem read primitive), so I cannot open data/ipc/matt_dm/host-mcp-requests/<id>.json to extract the question."*

**Root cause:** Option C tightened the sandbox by passing `--tools ""` to hard-deny every built-in tool. The U4 host-mcp-agent SKILL.md was written before Option C and instructed the agent to "Read the request file" — which it can't, because Read isn't in the available tool set.

**Two fix options were considered:**

- **A.** Re-enable Read scoped to the request file (`--tools Read` + `--allowed-tools Read(<path>)`). Note: `--allowed-tools` is auto-approve hint, NOT hard enforcement under `--dangerously-skip-permissions`. So path scoping is documentation, not a wall — agent can Read anywhere the daemon UID can reach.
- **C.** Inject the question directly into the agent's system prompt via `--append-system-prompt`. Sandbox stays at `--tools ""`. The skill protocol drops the file-read step entirely. The descriptor file is still written for daemon-side audit/cleanup, but the agent never touches it.

**Picked C** — preserves Option C's "zero filesystem access" posture and the agent only ever needed `question` from the descriptor anyway (`chatJid` is baked into `host_mcp_reply` by the daemon, never used by the skill). Untrusted user input is wrapped in `<<<USER_QUESTION_BEGIN>>>` / `<<<USER_QUESTION_END>>>` markers with explicit framing telling the agent not to interpret embedded text as instructions.

**Why this bites later:** When adding any new file-based daemon ↔ agent protocol, remember the agent has no Read. Pass payload via system prompt or argv, not file.

---

## 3. `--allowed-tools` is not a hard MCP allowlist

**Symptom:** Pre-Option C sandbox argv was `--allowed-tools "mcp__claude_ai_PitchBook_Premium__*,mcp__nanoclaw_host__host_mcp_reply"`. Threat-model assumption: a prompt-injected agent cannot call other MCPs (Gmail, Drive, etc.) because they're not in the allowlist.

**Root cause:** The claude CLI's `--allowed-tools` flag behaves as an **auto-approve hint** rather than a hard MCP allowlist. Combined with `--dangerously-skip-permissions`, every MCP tool the host's user-scope claude config exposes is reachable from the spawned session, regardless of allowlist contents. (Built-in tools like Bash/Read/Edit/Write are governed by `--tools`, which IS a hard allowlist — different code path.)

**Fix (Option C):** Defense in depth:

1. `--tools ""` hard-denies built-ins.
2. `--allowed-tools` documents intent + auto-approves the in-scope MCP and reply primitive.
3. `--disallowed-tools` enumerates every other known third-party MCP prefix from `KNOWN_HOST_MCP_PREFIXES` in `src/ipc.ts`. This is what actually blocks Gmail/Drive/etc.

**Residual risk + maintenance contract:** Any user-scope MCP installed via `claude mcp add ...` *after* the denylist was last updated bypasses the denylist until added to `KNOWN_HOST_MCP_PREFIXES`. A self-cleaning launchd job at `~/Library/LaunchAgents/com.nanoclaw.host-mcp-audit.plist` was scheduled for 2026-05-10 to detect drift and open a PR; long-term fix is `--strict-mcp-config` per the plan's risk table.

**Why this bites later:** Don't trust `--allowed-tools` to constrain MCP tool reach. Use `--disallowed-tools` for explicit deny + plan toward `--strict-mcp-config` for true hard allowlist.

---

## 4. launchctl plist needs explicit `DOCKER_HOST` for colima

**Symptom:** After kickstart-restarting the daemon, every container spawn failed with `pull access denied for nanoclaw-agent`. The image existed locally — but in colima, not in the docker daemon the launchd-spawned process was reaching.

**Root cause:** The launchctl plist's `EnvironmentVariables` block defaulted to no `DOCKER_HOST`, so the daemon's `docker` subprocesses fell back to `unix:///var/run/docker.sock`. That socket path doesn't exist on this machine — colima uses `unix:///Users/anarde/.colima/default/docker.sock`. The user's interactive shell had `DOCKER_HOST` set in shell rc files; launchd processes don't inherit shell rc.

**Fix:** Add explicit `DOCKER_HOST` to `~/Library/LaunchAgents/com.nanoclaw.plist`:

```xml
<key>EnvironmentVariables</key>
<dict>
    <!-- ... existing keys ... -->
    <key>DOCKER_HOST</key>
    <string>unix:///Users/anarde/.colima/default/docker.sock</string>
</dict>
```

Then `launchctl bootout && launchctl bootstrap` (kickstart -k does NOT re-read plist env changes).

**Why this bites later:** Any environment variable that lives in your shell rc but is required by a daemon-spawned subprocess needs to be in the plist. Common offenders: `PATH`, `DOCKER_HOST`, `OPENAI_API_KEY`, anything language-version-managed (asdf, fnm, volta).

---

## 5. Stale colima `in_use_by` symlink blocks restart

**Symptom:** `colima start` failed with `failed to run attach disk "colima", in use by instance "colima"`, but `limactl list` reported no instances and there was no actual VM process holding the disk.

**Root cause:** `~/.colima/_lima/_disks/colima/in_use_by` is a symlink that lima sets when an instance attaches the disk. If the instance crashes without cleanup (or is force-killed), the symlink persists and lima refuses to attach the disk to a fresh instance.

**Fix:** Verify no real process is holding it (`pgrep -f "colima start"`, `ps aux | grep -E "lima|qemu|vz"`), then `rm -f ~/.colima/_lima/_disks/colima/in_use_by`, then `colima start`.

**Why this bites later:** Any forced shutdown of colima (kill -9, OS panic, OOM) can leave this stale lock. Deleting the symlink is safe IF no real process is using the disk.

---

## 6. `trustedHostActions` is per-group state in SQLite, not in code

**Symptom:** First pitchbook query through the proxy returned *"Not authorized to call this scope."* The daemon's authz check was the source.

**Root cause:** Non-main groups must have the namespaced action `host_mcp_query:<scope>` in their `trustedHostActions` allowlist. This is stored per-group in `store/messages.db` (NOT `data/nanoclaw.db` — that file is a 0-byte vestige), table `registered_groups`, column `container_config` as JSON. The pre-existing Matt DM group only had the OLD flat action `pitchbook_check`, never updated when U5 introduced the namespaced form.

**Fix:**

```bash
sqlite3 store/messages.db \
  "UPDATE registered_groups SET container_config = '{\"trustedHostActions\":[\"pitchbook_check\",\"host_mcp_query:pitchbook\"]}' WHERE jid = 'slack:D0ALTQQQEV9';"
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # daemon caches in memory at startup
```

**Why this bites later:** Adding a new host-MCP scope requires updating BOTH the source (HOST_MCP_SCOPES in src/ipc.ts) AND every group's `trustedHostActions` that should be permitted. The latter is data state; code changes alone won't grant access. See the new "Adding a new host-MCP scope" section in CONTRIBUTING.md for the checklist.

---

## Meta-lesson: ship-and-test reveals what unit tests can't

68 vitest tests passed for U1–U8 + Option C. Every shipped session-end-to-end issue (#1, #2, #6) was outside their reach: variadic gobbling needs a real `claude` binary; system-prompt delivery is a protocol contract not testable at the spawn-seam level; per-group DB state is environment data, not code.

The unit-test bar caught real regressions (the U6 suite found and prevented several). It just doesn't substitute for actually firing a query through the system, end to end, once.

When shipping infrastructure with no UI, the smoke test isn't optional — it's the first real test.
