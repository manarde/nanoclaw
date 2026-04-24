# Host-MCP Proxy for Container Agents — Requirements

**Status:** Brainstorm complete, ready for `/ce-plan`
**Date:** 2026-04-23
**Scope tier:** Deep — feature (establishes reusable pattern)

## Problem

Zizou runs in a sandboxed container and cannot reach host-side MCPs (PitchBook Premium today; Gmail, Drive, Calendar, BigQuery, Clay, PowerNotes will matter later). Matt's primary interaction mode is DM, so the `/pitchbook-alerts` slash command — only reachable from Matt's interactive Claude Code session — is a bottleneck. The existing `run_pitchbook_check` IPC tool only handles the narrow watchlist-diff flow; free-form queries (company lookups, profile pulls, portfolio pulls, report analysis) aren't supported.

## Goal

Zizou can invoke any configured host-side MCP scope from chat, get an answer back in the same chat, and never see the host credentials. One proxy pattern; PitchBook is the first scope; new scopes (Gmail, Drive, etc.) = add config + a thin SKILL.md, no new daemon code.

## Non-goals

- **Not** a generic "run any host claude prompt" tool. Scopes are explicit and enumerated.
- **Not** changing the existing `run_pitchbook_check` watchlist flow. It keeps working alongside.
- **Not** interactive multi-turn conversations between Zizou and the host agent within one tool call. Each query is one-shot.
- **Not** moving MCPs into the container. Credentials stay host-side.

## Decisions made during brainstorm

### 1. Ship both PitchBook-specific flows AND the generalized pattern in parallel

Accept that real usage across 2–3 scopes will reshape the pattern. Better to validate with two scopes than optimize around only PitchBook.

### 2. Async response, posted as a new chat message

Zizou's MCP tool call returns immediately with `"Query dispatched."` The host-side agent runs in the background, then writes a `type: "message"` IPC file targeting the source chat. The user experiences it as Zizou saying "on it" and the answer arriving as a follow-up message seconds/minutes later. No blocking, no timeouts, handles slow PB queries naturally.

### 3. Per-scope authorization via `trustedHostActions`

Extends the existing pattern. A group's `containerConfig.trustedHostActions` lists specific scoped actions it can invoke:

```json
{ "trustedHostActions": ["pitchbook_check", "host_mcp_query:pitchbook", "host_mcp_query:gmail"] }
```

Main groups bypass the allowlist (same as today). Keeps the principle of least privilege as scopes grow.

### 4. Container-side skills describe *when* to use each flow; one IPC tool does the work

One new IPC tool: `run_host_mcp_query(scope, question, ...)`. Multiple thin `container/skills/pitchbook-<flow>/SKILL.md` files teach Zizou when and how to invoke it for specific PB flows. Context-window tight because each skill loads only when triggered.

## User-facing behavior

### Zizou's side (container)

New MCP tool:
```
run_host_mcp_query(
  scope: "pitchbook" | "gmail" | ...  (enum of configured scopes)
  question: string                     (free-form natural language)
)
```

Returns immediately: `"Dispatched <scope> query. The answer will arrive as a separate message."`

Container skills bundled at launch (SKILL.md only, no code). Finalized against the live PitchBook MCP tool list (17 tools enumerated 2026-04-24; `pitchbook_get_help_center_analysis` excluded as not user-useful — 16 tools exposed via 9 skills):

**Entity layer** (identify and profile any PB entity — company, investor, fund, deal, person):

| Skill | Triggers on | Host-side agent should use |
|---|---|---|
| `pitchbook-lookup` | "find / search / look up [company/investor/fund/person]" | `pitchbook_search` → returns PBID + basic identifiers |
| `pitchbook-profile` | "profile / details on / tell me about <PBID or name>" | `pitchbook_get_profile` (run `pitchbook_search` first if given a name) |

**Composed-entity layer** (multi-tool joined views):

| Skill | Triggers on | Host-side agent should use |
|---|---|---|
| `pitchbook-company` | "deals / investors / financials / team for <company>" | `pitchbook_get_company_deals`, `pitchbook_get_company_investors`, `pitchbook_get_company_financials`, `pitchbook_get_team_members` (composed) |
| `pitchbook-investor` | "portfolio / investments / funds for <investor>" | `pitchbook_get_investor_investments`, `pitchbook_get_investor_funds`, `pitchbook_get_team_members` (composed) |
| `pitchbook-deal` | "cap table / participants / details for <deal>" | `pitchbook_get_deal_cap_table`, `pitchbook_get_deal_participants` (composed with profile) |
| `pitchbook-fund` | "LPs / commitments / investors in <fund>" | `pitchbook_get_fund_lp_commitments` (composed with profile) |

**Content/analysis layer** (PB research + news + calls — prose-heavy outputs):

| Skill | Triggers on | Host-side agent should use |
|---|---|---|
| `pitchbook-reports` | "reports / research / whitepapers on <topic>" | `pitchbook_get_reports_analysis`, `pitchbook_get_private_market_reports_analysis`, `pitchbook_get_public_market_reports_analysis` (LLM picks based on query) |
| `pitchbook-news` | "news / recent coverage / headlines on <entity or topic>" | `pitchbook_get_news_analysis` |
| `pitchbook-transcripts` | "earnings call / transcript / what did they say on the call" | `pitchbook_get_call_transcripts_analysis` |

The *architecture* (one IPC tool + per-scope agent + container SKILLs) is unchanged from the original design — only the skill menu was resized against the real tool list.

Delegating to new scopes (Gmail, Drive, BigQuery, etc.) = add a `<scope>-agent` host skill + container SKILL.md files. No daemon changes.

### Matt's side (chat UX)

```
Matt: Zizou, pull the Thrive Capital portfolio
Zizou: On it — pulling Thrive's portfolio from PitchBook. (immediate)
[~30s later]
Zizou: Thrive Capital active portfolio (48 companies)
  • OpenAI (Series F, led Dec 2025, $25B valuation)
  • Stripe (Series I, co-invest)
  • ... [truncated or summarized based on question]
```

No distinction in the chat between "Zizou's own answer" and "answer from a host-MCP query" — it's all "Zizou" from the user's perspective.

## Host-side behavior

### Daemon handler (`src/ipc.ts`)

New IPC task type: `host_mcp_query`. On receipt:

1. **Auth**: `isMain` OR `sourceGroup.containerConfig.trustedHostActions` includes `host_mcp_query:<scope>`.
2. **Scope validation**: `scope` must be a key in the scope registry. Unknown scope → drop + warn.
3. **Debounce**: per-source-group, per-scope, 30s default (short because queries are user-triggered, not automated). Tunable.
4. **Spawn**: `claude -p --dangerously-skip-permissions "/host-mcp-agent <scope> <request-id>"` with the source group folder + question passed via env vars or a request file at `data/ipc/<source_group>/host-mcp-requests/<request-id>.json`. Detached, logged.
5. **Response**: host-side skill writes a `type: "message"` IPC reply to `data/ipc/<source_group>/messages/` targeting the source chat's jid. Daemon delivers via existing channel adapter.

### Host-side agent skill

New `.claude/skills/host-mcp-agent/SKILL.md`. Given `<scope>` and `<request-id>`:
1. Read `data/ipc/<source_group>/host-mcp-requests/<id>.json` for the question.
2. Resolve scope → scope config (allowed MCP tool prefixes, prompt guardrails).
3. Answer the question using only scope-allowed tools.
4. Format a concise reply appropriate for chat delivery (default ≤400 chars, or full content if user asked for a report summary).
5. Write reply to `data/ipc/<source_group>/messages/` with the source chat jid.
6. Delete the request file.

### Scope registry

Initial registry (hardcoded in daemon to start; migrate to config file if/when we add 3+ scopes):

| Scope | Allowed MCP prefixes | Default debounce |
|---|---|---|
| `pitchbook` | `mcp__claude_ai_PitchBook_Premium__*` | 30s |

Future scopes follow the same shape.

## Security properties

| Property | Still holds? | Notes |
|---|---|---|
| Credentials never in container | ✅ | Host-side claude is the only thing that sees PitchBook OAuth. |
| Container can't impersonate another group | ✅ | IPC dir identity is still the auth boundary. |
| Prompt-injected Zizou can't access arbitrary MCPs | ✅ | Per-scope allowlist limits what he can even ask for. |
| Prompt-injected Zizou can't burn unlimited API quota | Partial | Debounce limits rate; user-triggered is the expected case. Quota caps are PB's problem if abused. |
| Prompt-injected Zizou can't exfiltrate via response | Partial | Response goes to source chat only. If the chat has untrusted readers, the question's answer could leak. Matt's chats are all his own today. Revisit if adding shared groups. |

## Success criteria

1. From matt_dm: "Zizou, look up Vercel on PitchBook" → profile summary arrives as a chat message within 60s.
2. From matt_dm: "Zizou, pull Thrive Capital's portfolio" → portfolio arrives, formatted as a readable list.
3. Same tool call from a non-trusted group → dropped silently by daemon, never reaches the MCP.
4. Adding a second scope (e.g., Gmail stub) requires: one scope registry entry + one host skill + one container SKILL.md. No changes to `src/ipc.ts`, `ipc-mcp-stdio.ts`, or daemon restart needed beyond the usual rebuild.
5. Existing `run_pitchbook_check` watchlist flow continues working unchanged.

## Open questions (for /ce-plan)

- **Scope registry config location**: hardcoded in `src/ipc.ts` vs `groups/global/host-mcp-scopes.json`? Start hardcoded, move to config when we hit 3+ scopes.
- **Request context**: does the host-side agent need any recent chat history to answer well, or is the question + scope enough? MVP assumption: question alone suffices. Revisit if answers are too shallow.
- **Reply length policy**: hard cap? Chunking? Channel-specific (Slack 4000 chars, Telegram 4096)? MVP: let the host-side agent decide; daemon's existing chat-send splitting handles overflow.
- **Failure delivery**: if the host-side query errors (MCP down, auth expired, no results), how does Zizou tell the user? MVP: host-side agent posts a plain-text error as the reply ("PitchBook query failed: auth expired — please re-authenticate in your Claude Code session").

## Dependencies / Assumptions

- `claude -p` continues to inherit the user's Claude.ai MCP sessions (verified this session).
- PitchBook MCP auth is active in Matt's user-level Claude Code state when a query fires (he may need to re-auth occasionally via an interactive session).
- `trustedHostActions` stays on `containerConfig` as the auth allowlist (established by the pitchbook-alerts feature).
- No new dependencies in `container/agent-runner/package.json` or Dockerfile.

## Scope boundaries

**In:** generalized `run_host_mcp_query` IPC tool + `host-mcp-agent` host skill + per-scope auth + PitchBook scope registered + 9 PB container skills.

**Deferred:** Gmail/Drive/Calendar/BigQuery/Clay/PowerNotes scopes (add when individually needed). Multi-turn / conversational host-side agent sessions. Scope config hot-reload. Structured result artifacts (JSON attachments back to container). Rate budget per user per day.

**Outside this product's identity:** host MCP becoming accessible to anyone outside Matt's chat scope (current and future). We're not building a multi-tenant gateway.
