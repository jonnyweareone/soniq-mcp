# SONIQ MCP — OAuth 2.0 Integration Guide

## Endpoints

| Endpoint | URL |
|---|---|
| Authorise | `https://mcp.soniqlabs.co.uk/oauth/authorize` |
| Token | `https://mcp.soniqlabs.co.uk/oauth/token` |
| Callback | `https://dtosgubmmdqxbeirtbom.supabase.co/functions/v1/mcp-oauth-callback` |
| SSE | `https://mcp.soniqlabs.co.uk/sse` |

## OAuth 2.0 Flow

```
1. Redirect user to authorize endpoint with client_id, scope, state
2. User enters SONIQ API key on auth page
3. Server issues auth code, redirects to redirect_uri
4. Client POSTs code to token endpoint
5. Server returns JWT bearer token
6. Use JWT for SSE MCP session
```

## Scopes

| Scope | Description |
|---|---|
| `calls:read` | View calls, history, transcripts |
| `calls:write` | Make calls, log notes |
| `contacts:read` | Look up contacts, screen pops |
| `contacts:write` | Create/update contacts |
| `memory:read` | Caller memory, semantic search |
| `users:admin` | Manage agents |
| `numbers:admin` | Manage phone numbers |
| `flows:admin` | Manage call flows |
| `supervisor:write` | Monitor calls |

## Partner Hierarchy

Partner-scoped keys can configure child orgs but cannot access their call data, contacts, or transcripts. RLS enforces this at the database level.

Generate API keys at: **Settings → API Keys** in the SONIQ portal at https://soniqmail.co.uk
