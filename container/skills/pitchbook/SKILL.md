---
name: pitchbook
description: Pull PitchBook data (company, investor, fund, deal, person, reports, news, call transcripts) via the host-side PitchBook MCP. Triggers on "find/search/look up" something on PitchBook, "profile / details on" an entity, "deals / investors / financials / team for" a company (e.g. "deals for Databricks"), "portfolio / investments / funds for" an investor (e.g. "portfolio for Andreessen Horowitz", "profile for Thrive Capital"), "cap table / participants for" a deal (e.g. "cap table for Anthropic Series C"), "LPs / commitments / investors in" a fund (e.g. "LP commitments for Sequoia Capital XVI"), "reports / research / whitepapers on" a topic (e.g. "reports on AI rollups"), "news / recent coverage / headlines on" an entity (e.g. "news on OpenAI"), and "earnings call / transcript / what did they say on the call" (e.g. "earnings call transcript for Palantir"). Also: "find Vercel on PitchBook".
---

# Pull PitchBook data via the host-side MCP

The user is asking for PitchBook data — company, investor, fund, deal, person, reports, news, or call transcripts. You don't have direct PitchBook access in the container. Call `run_host_mcp_query` with `scope="pitchbook"` and a natural-language `question` that fully expresses what they want. The question is passed through to a host-side Claude session that has live PitchBook MCP access and will compose the right PB tool calls.

## Tool map

One skill, nine flows. The host-side agent picks the right PitchBook MCP tool(s) based on the shape of your question. Don't mention tool names to the user — just ask a clear question.

| Question shape | Expected PitchBook tool(s) |
|---|---|
| Lookup / search ("find / search / look up X") | `pitchbook_search` |
| Profile ("profile / details on / tell me about X") | `pitchbook_get_profile` (search first if given a name) |
| Company view ("deals / investors / financials / team for <company>") | `pitchbook_get_company_deals`, `..._company_investors`, `..._company_financials`, `..._team_members` (composed) |
| Investor view ("portfolio / investments / funds for <investor>") | `pitchbook_get_investor_investments`, `..._investor_funds`, `..._team_members` (composed) |
| Deal view ("cap table / participants for <deal>") | `pitchbook_get_deal_cap_table`, `..._deal_participants` (composed with profile) |
| Fund view ("LPs / commitments / investors in <fund>") | `pitchbook_get_fund_lp_commitments` (composed with profile) |
| Reports ("reports / research / whitepapers on <topic>") | `pitchbook_get_reports_analysis`, `..._private_market_reports_analysis`, `..._public_market_reports_analysis` |
| News ("news / recent coverage / headlines on <X>") | `pitchbook_get_news_analysis` |
| Transcripts ("earnings call / transcript / what did they say") | `pitchbook_get_call_transcripts_analysis` |

## Canonical invocation

```
run_host_mcp_query(
  scope="pitchbook",
  question="Look up Vercel on PitchBook and give me their latest round, lead investor, and valuation."
)
```

## End your turn immediately after the call

**After calling this tool, briefly acknowledge to the user (e.g., "On it — pulling Vercel from PitchBook.") and end your turn immediately.** Do not wait for the answer. Do not retry the tool. The answer will arrive as a separate chat message within seconds to minutes.

## Tips

- **Be verbose and specific in `question`.** The host session can compose multi-step PB queries, so a richer question = a richer answer. "Pull Thrive Capital's portfolio, grouped by vintage year, with lead/co-invest status and latest round for each" beats "Thrive portfolio".
- **Use the entity's real name.** The host will PBID-resolve via `pitchbook_search`; you don't need to pass IDs.
- **Ask for the format you want.** For lists, say so ("bulleted", "top 10", "by vintage", "just names and stages"). For reports/news/transcripts, name the topic or company clearly.
- **One question per call.** If the user asks for two unrelated pulls (e.g. "Thrive's portfolio AND news on OpenAI"), make two separate `run_host_mcp_query` calls, each with its own question.
