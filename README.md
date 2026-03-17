# SONIQ MCP Server

**The first telephony Model Context Protocol server.**

Connect any AI assistant — Claude, GPT, Copilot — directly to your SONIQ phone system. Make calls, look up callers, search your entire call history with natural language, manage users and numbers, and get real-time screen pops — all through MCP tools.

[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-7c3aed)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Tools-24-db2777)](https://github.com/jonnyweareone/soniq-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-green)](https://nodejs.org)

---

## Why SONIQ MCP is unique

Every phone system has a REST API. Only SONIQ has an MCP server — and only SONIQ combines MCP with **vector-powered call memory**.

Every call processed by SONIQ generates an AI transcript and summary, embedded as vectors. The `search_call_memory` and `get_caller_memory` tools expose this to any connected AI:

- *"Has this customer complained about billing before?"* — searches months of transcripts via embeddings
- *"Who called about the Manchester project this week?"* — semantic vector search, not keyword matching
- *"What did we promise this customer last time?"* — full caller history with AI summaries in under 100ms

Combined with real-time screen pops, CRM sync across 60+ integrations, and the ability to actually make and control calls, SONIQ MCP turns any AI into a fully-capable telephony agent.

---

## Quick connect

### Remote — Claude.ai and any MCP client

```
SSE endpoint: https://mcp.soniqlabs.co.uk/sse
```

Connect with your SONIQ API key via OAuth. No installation needed.

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "soniq": {
      "command": "npx",
      "args": ["-y", "soniq-mcp"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "SONIQ_API_BASE": "https://api.soniqlabs.co.uk"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http soniq https://mcp.soniqlabs.co.uk/sse
```

---

## Authentication

### API Key (direct)

Generate an API key in the SONIQ platform at **Settings → API Keys**. Pass it as `api_key` in each tool call.

```
Format: soniq_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### OAuth 2.0 (for Anthropic Directory / Claude.ai)

| Endpoint | URL |
|---|---|
| Authorise | `https://mcp.soniqlabs.co.uk/oauth/authorize` |
| Token | `https://mcp.soniqlabs.co.uk/oauth/token` |
| Client ID | `soniq-mcp` |

**Flow:** User logs in with their SONIQ API key → auth code issued → exchanged for bearer token → used in MCP session.

### Scopes

| Scope | Description |
|---|---|
| `calls:read` | View live calls, history, transcripts, queue status |
| `calls:write` | Make calls, log notes |
| `contacts:read` | Look up contacts, get screen pops |
| `contacts:write` | Create and update contacts |
| `memory:read` | Caller memory, semantic search, analytics |
| `users:admin` | Add, update, remove agents |
| `numbers:admin` | Search, order, assign phone numbers |
| `flows:admin` | Create and manage call flows |
| `supervisor:write` | Monitor live calls |

---

## Tools (24)

### Call tools

| Tool | Scope | What it does |
|---|---|---|
| `get_live_calls` | calls:read | Active calls right now |
| `get_call_history` | calls:read | CDR with date filters, AI summaries |
| `get_call_detail` | calls:read | Full detail, transcript, recording |
| `get_missed_calls` | calls:read | Unanswered calls needing callback |
| `get_queue_status` | calls:read | Ringing, in-call, queue depth |
| `make_call` | calls:write | Initiate outbound call |
| `add_call_note` | calls:write | Log note, auto-syncs to CRM |

### Contact & screen pop tools

| Tool | Scope | What it does |
|---|---|---|
| `lookup_contact` | contacts:read | Phone/email lookup across all CRMs |
| `get_screen_pop` | contacts:read | Full enriched caller data in ~300ms |
| `create_contact` | contacts:write | New contact, synced to CRMs |
| `update_contact` | contacts:write | Update fields, synced to CRMs |

### Memory & AI tools — unique to SONIQ

| Tool | Scope | What it does |
|---|---|---|
| `get_caller_memory` | memory:read | Full call history + AI memory for a number |
| `search_call_memory` | memory:read | Semantic vector search across all transcripts |
| `get_call_analytics` | memory:read | Volume, answer rate, avg duration |

### Admin tools

| Tool | Scope | What it does |
|---|---|---|
| `list_users` | users:admin | All users with live presence |
| `create_user` | users:admin | Add agent, provision extension |
| `update_user` | users:admin | Update extension, role, settings |
| `remove_user` | users:admin | Offboard, release extension |
| `search_numbers` | numbers:admin | Available numbers by area/prefix |
| `allocate_number` | numbers:admin | Order and assign a number |
| `list_numbers` | numbers:admin | Org numbers + call flow assignments |
| `list_call_flows` | flows:admin | IVR, hunt groups, AI agents |
| `create_call_flow` | flows:admin | Build new routing flow |
| `monitor_call` | supervisor:write | Silent supervisor listen |

---

## Examples

### 1. Morning briefing
```
"How many calls did we miss yesterday and who were they from?"
```
Uses `get_missed_calls` → returns list with caller numbers, times, known contact names.

### 2. Pre-call preparation
```
"A call is coming in from +447700900123. What do we know about them?"
```
Uses `get_screen_pop` + `get_caller_memory` → returns contact name, company, last call topic, all previous interactions — before the agent picks up.

### 3. Semantic call search
```
"Find all calls this month where the customer mentioned a complaint about their invoice"
```
Uses `search_call_memory` with natural language → vector search returns ranked results with call IDs, dates, summary excerpts.

### 4. Add a new team member
```
"Add Sarah Collins as an agent, email sarah@company.com, extension 105"
```
Uses `create_user` → provisions account, generates SIP credentials, sends invitation email.

### 5. Get a Manchester number
```
"We need a Manchester number for the sales team, assign it to the Sales Hunt Group"
```
Uses `search_numbers` then `allocate_number` with the call flow ID.

### 6. Post-call CRM note
```
"Log a note on the last call from Acme Corp saying we agreed to send a proposal by Friday"
```
Uses `get_call_history` then `add_call_note` → synced to HubSpot/Salesforce/Pipedrive automatically.

---

## Self-hosting

```bash
git clone https://github.com/jonnyweareone/soniq-mcp
cd soniq-mcp
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SONIQ_API_BASE
npm install
npm start
```

Runs on port 3200. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full production setup guide.

---

## Privacy Policy

See [https://soniqlabs.co.uk/privacy](https://soniqlabs.co.uk/privacy)

The SONIQ MCP server is a proxy to your own SONIQ deployment. No call data, contacts, or organisation data passes through any third-party service. All data stays within your deployment.

---

## Support

- **Email:** support@soniqlabs.co.uk
- **Docs:** [https://soniqlabs.co.uk/developer](https://soniqlabs.co.uk/developer)
- **Issues:** [https://github.com/jonnyweareone/soniq-mcp/issues](https://github.com/jonnyweareone/soniq-mcp/issues)
- **Platform:** [https://soniqmail.co.uk](https://soniqmail.co.uk)

---

## License

MIT © SONIQ Labs
