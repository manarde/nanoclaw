---
name: pitchbook-alerts
description: PitchBook monitoring and alerts. Track VCs, PEs, AI rollups, and specific managers for deal flow, fund raises, portfolio changes, and team moves. Runs via host-side PitchBook MCP. Triggers on "pitchbook alerts", "pitchbook watch", "pb alerts", "deal alerts", "investor alerts".
---

# PitchBook Alerts

Monitor PitchBook entities and alert on changes. Runs at the host level where PitchBook MCP is authenticated.

## Alert Profiles

| Profile | Entities | What to Track |
|---------|----------|---------------|
| **VC Watch** | VC firms | New investments (stage, sector, check size), fund raises (size vs prior vintage), partner moves, portfolio exits |
| **PE Watch** | PE firms | Add-on acquisitions (rollup activity), new platform deals, fund closes, portfolio company financials |
| **AI Rollups** | AI acquirers | New acquisitions, deal frequency/sizing, sector verticals being consolidated |
| **Manager Watch** | Individual GPs/partners | Portfolio construction (concentration, stage mix, sector allocation), deals led, fund performance, firm changes |

## Data Storage

All state lives in `data/pitchbook/`:

```
data/pitchbook/
  watchlists/
    {watchlist-slug}.json   # Named watchlist (e.g., ai-rollups.json, pe-megafunds.json)
  snapshots/                # Last-known state per PBID (shared across watchlists)
    {pbid}.json             # Snapshot with timestamp
  alerts/                   # Alert history
    {date}.json             # Daily alert log
```

### Multiple Watchlists

Users can create as many watchlists as they want, each with its own theme, entities, settings, and delivery preferences. Examples:
- `ai-rollups.json` — AI acquirers and their consolidation activity
- `pe-megafunds.json` — Large PE firms and fund raises
- `seed-vcs.json` — Early-stage VCs and their new investments
- `gp-tracker.json` — Specific managers across firms

Each watchlist runs independently — different check frequencies, different alert channels, different priority thresholds.

### Watchlist Schema

```json
{
  "name": "AI Rollups",
  "slug": "ai-rollups",
  "description": "Tracking AI acquirers and platform consolidation plays",
  "entries": [
    {
      "pbid": "41161-24",
      "name": "Thoma Bravo",
      "entity_type": "business_entity",
      "profile": "pe_watch",
      "track": ["deals", "funds", "team", "investments"],
      "priority": "high",
      "added": "2026-03-20",
      "notes": "AI rollup thesis"
    }
  ],
  "settings": {
    "check_interval": "daily",
    "digest_channel": "telegram_main",
    "immediate_alerts": ["new_deal", "new_fund", "gp_departure"],
    "digest_time": "08:00"
  }
}
```

### Snapshot Schema

Each snapshot captures the current state for diffing:

```json
{
  "pbid": "41161-24",
  "timestamp": "2026-03-20T08:00:00Z",
  "profile": {
    "name": "...",
    "ownership_status": "...",
    "aum": "...",
    "total_investments": 0
  },
  "deals": [],
  "investments": [],
  "funds": [],
  "team": []
}
```

## Workflow

### Step 1: Setup / Manage Watchlists

When user runs `/pitchbook-alerts`, start here:

1. Check `data/pitchbook/watchlists/` for existing watchlists
2. If none exist, create the directory structure
3. Show existing watchlists (if any) with entity counts
4. Ask user what they want to do:
   - **Create watchlist** — name it, set description, configure settings
   - **Add entity to watchlist** — pick watchlist, search PitchBook, assign profile
   - **Remove entity** — pick watchlist, pick entity
   - **List watchlists** — show all watchlists with their entities
   - **Run check now** — check one watchlist or all
   - **View recent alerts** — show latest alerts, optionally filtered by watchlist
   - **Configure settings** — change a watchlist's channel, timing, alert types
   - **Delete watchlist** — remove a watchlist entirely

#### Creating a Watchlist

```
1. AskUserQuestion: "What should this watchlist be called? (e.g., 'AI Rollups', 'Seed VCs', 'GP Tracker')"
2. AskUserQuestion: "Brief description of what this watchlist tracks?"
3. AskUserQuestion: "Default alert profile for entities? (vc_watch / pe_watch / ai_rollup / manager_watch)"
4. AskUserQuestion: "Check frequency? (daily / weekly / manual)"
5. AskUserQuestion: "Which channel for alerts? (e.g., telegram_main, slack_main)"
6. Create data/pitchbook/watchlists/{slug}.json with settings
7. Prompt to add first entity
```

#### Adding an Entity

```
1. If multiple watchlists exist, AskUserQuestion: "Which watchlist?" (show list)
2. AskUserQuestion: "What entity do you want to watch? (company, investor, fund, or person name)"
3. Use pitchbook_search to find matches
4. Present results, let user confirm the right one
5. AskUserQuestion: "Which alert profile? (vc_watch / pe_watch / ai_rollup / manager_watch)" (default from watchlist)
6. AskUserQuestion: "Priority? (high = immediate alerts, normal = digest only)"
7. Add to watchlist JSON
8. Take initial snapshot (Step 2) so future checks have a baseline
```

### Step 2: Take Snapshot

For each watchlist entry, pull current state based on profile:

**vc_watch / pe_watch:**
```
1. pitchbook_get_profile(pbid)                    → firm overview, AUM
2. pitchbook_get_investor_investments(pbid)        → current portfolio
3. pitchbook_get_investor_funds(pbid)              → fund history
4. pitchbook_get_team_members(pbid)                → key people
```

**ai_rollup:**
```
1. pitchbook_get_profile(pbid)                     → company overview
2. pitchbook_get_company_deals(pbid)               → acquisition history
3. pitchbook_get_company_investors(pbid)            → who's backing them
4. pitchbook_get_team_members(pbid)                 → leadership
```

**manager_watch (person):**
```
1. pitchbook_get_profile(pbid)                     → bio, current firm
2. pitchbook_get_investor_investments(firm_pbid)    → deals at current firm
3. pitchbook_get_investor_funds(firm_pbid)          → funds they're on
```

Save snapshot to `data/pitchbook/snapshots/{pbid}.json` with timestamp.

### Step 3: Check Cycle (Diff & Alert)

Compare new snapshot against stored snapshot. Detect changes by category:

**Deal Changes:**
- New deals not in previous snapshot → `new_deal` alert
- Deal size/status changes → `deal_update` alert
- Count delta (e.g., 3 new add-ons this month) → `velocity` alert

**Fund Changes:**
- New fund appearing → `new_fund` alert
- Fund status change (e.g., Raising → Closed) → `fund_close` alert
- Fund size vs prior vintage → `fund_sizing` alert

**Team Changes:**
- New team member → `new_hire` alert
- Team member removed → `departure` alert (high priority if GP/partner)
- Role changes → `promotion` alert

**Investment Changes:**
- New portfolio company → `new_investment` alert
- Exit recorded → `exit` alert
- Investment count velocity → `deployment_pace` alert

**Portfolio Construction (manager_watch):**
- Sector concentration shift → `thesis_shift` alert
- Stage mix change → `stage_shift` alert
- Check size trend → `sizing_trend` alert

### Step 4: Format & Deliver

**Immediate alerts** (high-priority events):
```
Use IPC or direct channel send to notify immediately.
Format: "[PB Alert] {entity_name}: {event_type} — {summary}"
Example: "[PB Alert] Vista Equity: New add-on acquisition — Acme Corp ($450M)"
```

**Daily digest** (batched, per watchlist):
```
Each watchlist with changes gets its own digest, sent to that watchlist's configured channel.

## 📋 AI Rollups — {date}

**Thoma Bravo**
- Acquired CloudSecOps ($320M, add-on to Sailpoint platform)
- 4th AI-adjacent add-on in 90 days

**Databricks**
- Acquired ModelOps.ai (Series B, $85M last round)

---

## 📋 PE Megafunds — {date}

**Vista Equity Partners**
- Fund VIII closed at $12B (up 20% vs Fund VII)

---

## 📋 GP Tracker — {date}

**John Smith (Andreessen Horowitz)**
- Led Series B in QuantumAI ($40M)
- Portfolio now 65% AI/ML (was 55% last month)
```

### Step 5: Update Snapshots

After successful check cycle, overwrite snapshots with new state. Log alerts to `data/pitchbook/alerts/{date}.json`.

## Running Checks

### Manual
User runs `/pitchbook-alerts` → select "Run check now" → pick a watchlist or "all"

### Recurring (via /loop)
```
/loop 24h /pitchbook-alerts check          # check all watchlists
/loop 12h /pitchbook-alerts check ai-rollups  # check one watchlist more frequently
```

Or the user can ask their NanoClaw agent to schedule a task:
```
"Schedule a daily PitchBook check at 7am"
→ Agent creates cron task via IPC that triggers this skill
```

### From NanoClaw agent (IPC trigger)
Container agents call the `run_pitchbook_check` MCP tool (takes a watchlist slug or "all"). The NanoClaw daemon validates the request (main group only, slug must resolve to an existing watchlist, 5-minute debounce per slug) and spawns `claude -p "/pitchbook-alerts check <slug>"` at the host — which runs this skill with full PitchBook MCP access. The headless run is expected to deliver its digest by writing a `type: "message"` IPC file to `data/ipc/main/messages/` targeting the jid of the watchlist's `digest_channel`, so the daemon routes it through the appropriate channel adapter.

## Important Notes

- PitchBook MCP is only available at the **host level** (Claude Code). Container agents cannot call PitchBook directly.
- Rate limit awareness: batch entity checks, don't hammer the API.
- Snapshots can grow large for firms with 500+ investments. Use `limit` parameters on API calls and only track recent activity (last 2 years) unless user requests full history.
- Person PBIDs use the format `XXXXX-XXP`. Fund PBIDs use `XXXXX-XXF`. Deal PBIDs use `XXXXX-XXT`.
