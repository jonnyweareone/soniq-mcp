#!/usr/bin/env node
/**
 * SONIQ MCP Server v1.1
 * The first telephony Model Context Protocol server.
 *
 * Transports:
 *   - HTTP SSE  → https://mcp.soniqlabs.co.uk/sse  (remote clients, Claude.ai)
 *   - stdio     → MCP_TRANSPORT=stdio               (Claude Desktop, local)
 *
 * Auth:
 *   - API Key   → Authorization: Bearer sk_live_...
 *   - OAuth 2.0 → /oauth/authorize + /oauth/token   (Anthropic Directory)
 */
import 'dotenv/config';
import { createServer } from 'http';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = process.env.SONIQ_API_BASE || 'http://127.0.0.1:3100';
const PORT = parseInt(process.env.MCP_PORT || '3200');
const USE_HTTP = process.env.MCP_TRANSPORT !== 'stdio';
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'soniq-mcp';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'https://mcp.soniqlabs.co.uk';

function sb() { return createClient(SUPABASE_URL, SUPABASE_KEY); }

// ── OAuth state store (in-memory; use Redis in production) ───────────────────
const oauthCodes = new Map();   // code → { org_id, scope, expires }
const oauthTokens = new Map();  // token → { org_id, scope, expires }

// ── API call helper ───────────────────────────────────────────────────────────
async function apiCall(path, method = 'GET', body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const err = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

// ── Tool definitions with Anthropic-required safety annotations ───────────────
const TOOLS = [
  // ── calls:read ──────────────────────────────────────────────────────────────
  {
    name: 'get_live_calls',
    description: 'Get all active calls happening right now in the organisation. Returns caller number, agent, status, started time.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string', description: 'SONIQ API key with calls:read scope' },
    }, required: ['api_key'] }
  },
  {
    name: 'get_call_history',
    description: 'Get call history with optional date filters. Returns CDR records with duration, outcome, AI summary, and recording URL.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      limit: { type: 'number', description: 'Max records to return (default 20, max 200)' },
      from: { type: 'string', description: 'ISO date string e.g. 2026-01-01' },
      to: { type: 'string', description: 'ISO date string e.g. 2026-03-31' },
    }, required: ['api_key'] }
  },
  {
    name: 'get_call_detail',
    description: 'Get full detail of a specific call including transcript, AI summary, screen pop data, recording URL.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      call_id: { type: 'string', description: 'UUID of the call' },
    }, required: ['api_key', 'call_id'] }
  },
  {
    name: 'get_missed_calls',
    description: 'Get unanswered calls that need a callback. Includes caller number, time, and any known contact data.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
    }, required: ['api_key'] }
  },
  {
    name: 'get_queue_status',
    description: 'Get current call queue depth, number of calls ringing vs in-call, agent availability.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
    }, required: ['api_key'] }
  },
  // ── calls:write ─────────────────────────────────────────────────────────────
  {
    name: 'make_call',
    description: 'Initiate an outbound call to a phone number. Returns a LiveKit room token for the calling agent to join via the SONIQ Phone app.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      to: { type: 'string', description: 'Phone number in E.164 format e.g. +447700900123' },
      from_extension: { type: 'string', description: 'Agent extension number e.g. "101"' },
      cli: { type: 'string', description: 'Optional caller ID override in E.164 format' },
    }, required: ['api_key', 'to'] }
  },
  {
    name: 'add_call_note',
    description: 'Add a note or outcome to a call record. The note is also queued for sync to any connected CRM.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      call_id: { type: 'string' },
      note: { type: 'string', description: 'Note or call outcome to log' },
    }, required: ['api_key', 'call_id', 'note'] }
  },
  // ── contacts ─────────────────────────────────────────────────────────────────
  {
    name: 'lookup_contact',
    description: 'Look up a contact by phone number or email. Searches local contacts AND all connected CRMs (HubSpot, Salesforce, Pipedrive, Reapit, Clio) in parallel. Returns within 300ms.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      phone: { type: 'string', description: 'Phone number (any format, normalised automatically)' },
      email: { type: 'string', description: 'Email address' },
    }, required: ['api_key'] }
  },
  {
    name: 'get_screen_pop',
    description: 'Get the full screen pop payload for an inbound caller number. Returns enriched contact including name, company, last call summary, and CRM link. Designed for real-time use during call ring.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      phone: { type: 'string', description: 'Caller phone number in any format' },
      org_id: { type: 'string', description: 'Organisation UUID' },
    }, required: ['api_key', 'phone', 'org_id'] }
  },
  {
    name: 'create_contact',
    description: 'Create a new contact record. Automatically synced to all connected CRM integrations.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      phone: { type: 'string' },
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      email: { type: 'string' },
      company: { type: 'string' },
    }, required: ['api_key'] }
  },
  {
    name: 'update_contact',
    description: 'Update fields on an existing contact. Changes are synced to connected CRM integrations.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      contact_id: { type: 'string', description: 'UUID of the contact to update' },
      fields: { type: 'object', description: 'Fields to update: first_name, last_name, email, company, tags, notes' },
    }, required: ['api_key', 'contact_id', 'fields'] }
  },
  // ── memory:read + ai:read ────────────────────────────────────────────────────
  {
    name: 'get_caller_memory',
    description: 'Get the complete call history and AI-generated memory for a caller number. This is the vector memory — all past interactions, topics discussed, outcomes, and sentiment. Use this before answering a call to know the full caller context.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      phone: { type: 'string', description: 'Caller phone number' },
      org_id: { type: 'string', description: 'Organisation UUID' },
    }, required: ['api_key', 'phone', 'org_id'] }
  },
  {
    name: 'search_call_memory',
    description: 'Semantic search across all call transcripts and AI summaries using vector embeddings. Answers questions like: "who called about billing issues?", "find calls where the customer mentioned cancelling", "calls about the Manchester office". Returns ranked results with call metadata.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      org_id: { type: 'string' },
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    }, required: ['api_key', 'org_id', 'query'] }
  },
  {
    name: 'get_call_analytics',
    description: 'Get call statistics: total volume, answer rate, average talk duration, missed call count. Optionally filter by date range.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      org_id: { type: 'string' },
      from: { type: 'string', description: 'Start date ISO string' },
      to: { type: 'string', description: 'End date ISO string' },
    }, required: ['api_key', 'org_id'] }
  },
  // ── users:admin ──────────────────────────────────────────────────────────────
  {
    name: 'list_users',
    description: 'List all users in the organisation with their extensions, roles, and current live presence status (available, busy, ringing, DND).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
    }, required: ['api_key'] }
  },
  {
    name: 'create_user',
    description: 'Add a new agent or admin to the phone system. Provisions their extension, SIP credentials, and device settings. Sends an invitation email.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      email: { type: 'string' },
      display_name: { type: 'string' },
      extension: { type: 'string', description: '3-5 digit extension number e.g. "101"' },
      role: { type: 'string', enum: ['agent', 'supervisor', 'admin'], description: 'Default: agent' },
    }, required: ['api_key', 'email', 'extension'] }
  },
  {
    name: 'update_user',
    description: "Update a user's settings, extension number, display name, or role.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      user_id: { type: 'string', description: 'UUID of the org_user record' },
      fields: { type: 'object', description: 'Fields to update: display_name, extension, role, settings' },
    }, required: ['api_key', 'user_id', 'fields'] }
  },
  {
    name: 'remove_user',
    description: 'Remove a user from the phone system and release their extension back to the pool.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      user_id: { type: 'string', description: 'UUID of the org_user record to remove' },
    }, required: ['api_key', 'user_id'] }
  },
  // ── numbers:admin ────────────────────────────────────────────────────────────
  {
    name: 'search_numbers',
    description: 'Search available phone numbers by UK area or prefix. Returns numbers ready to order and allocate.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      area: { type: 'string', description: 'Area name e.g. "Manchester", "London", "Cardiff"' },
      prefix: { type: 'string', description: 'Number prefix e.g. "0161", "020", "029"' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    }, required: ['api_key'] }
  },
  {
    name: 'allocate_number',
    description: 'Allocate an available phone number to the organisation. Optionally assign it to a call flow immediately.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      number_id: { type: 'string', description: 'UUID of the available number from search_numbers' },
      call_flow_id: { type: 'string', description: 'Optional UUID of call flow to assign this number to' },
    }, required: ['api_key', 'number_id'] }
  },
  {
    name: 'list_numbers',
    description: 'List all phone numbers assigned to the organisation with their call flow assignments.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
    }, required: ['api_key'] }
  },
  // ── flows:admin ──────────────────────────────────────────────────────────────
  {
    name: 'list_call_flows',
    description: 'List all call flows (IVR menus, hunt groups, AI agent flows, voicemail) in the organisation.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
    }, required: ['api_key'] }
  },
  {
    name: 'create_call_flow',
    description: 'Create a new call flow to route inbound calls. Supports ring_user, ring_group, IVR menu, AI agent, and voicemail step types.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      name: { type: 'string', description: 'Display name for this call flow' },
      flow_type: { type: 'string', enum: ['simple_ring', 'hunt_group', 'ivr', 'ai_agent'] },
      workflow_steps: { type: 'array', description: 'Array of step objects defining the call routing logic' },
    }, required: ['api_key', 'name', 'flow_type'] }
  },
  // ── supervisor:write ──────────────────────────────────────────────────────────
  {
    name: 'monitor_call',
    description: 'Silently monitor a live call as a supervisor without the parties knowing. Returns a LiveKit room token to join as a listener via SONIQ Phone app.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {
      api_key: { type: 'string' },
      call_id: { type: 'string', description: 'UUID of the live call to monitor' },
    }, required: ['api_key', 'call_id'] }
  },
];

// ── Tool handler ──────────────────────────────────────────────────────────────
async function handleTool(name, a) {
  switch (name) {
    case 'get_live_calls': return ok(await apiCall('/api/v1/calls/live', 'GET', undefined, a.api_key));
    case 'get_call_history': {
      const p = new URLSearchParams({ limit: String(a.limit || 20) });
      if (a.from) p.set('from', a.from);
      if (a.to) p.set('to', a.to);
      return ok(await apiCall(`/api/v1/calls?${p}`, 'GET', undefined, a.api_key));
    }
    case 'get_call_detail': return ok(await apiCall(`/api/v1/calls/${a.call_id}`, 'GET', undefined, a.api_key));
    case 'get_missed_calls': return ok(await apiCall('/api/v1/analytics/missed', 'GET', undefined, a.api_key));
    case 'get_queue_status': {
      const d = await apiCall('/api/v1/calls/live', 'GET', undefined, a.api_key);
      const calls = d.calls || [];
      return ok({ queued: calls.filter(c => c.status === 'ringing').length, in_call: calls.filter(c => c.status === 'answered').length, total_live: calls.length });
    }
    case 'make_call': return ok(await apiCall('/api/v1/calls', 'POST', { to: a.to, from_extension: a.from_extension, cli: a.cli }, a.api_key));
    case 'add_call_note': return ok(await apiCall(`/api/v1/calls/${a.call_id}/note`, 'POST', { note: a.note }, a.api_key));
    case 'lookup_contact': {
      const p = new URLSearchParams();
      if (a.phone) p.set('phone', a.phone);
      if (a.email) p.set('email', a.email);
      return ok(await apiCall(`/api/v1/contacts/lookup?${p}`, 'GET', undefined, a.api_key));
    }
    case 'get_screen_pop': {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/contacts-lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ org_id: a.org_id, phone: a.phone }),
      });
      return ok(await r.json());
    }
    case 'create_contact': return ok(await apiCall('/api/v1/contacts', 'POST', a, a.api_key));
    case 'update_contact': return ok(await apiCall(`/api/v1/contacts/${a.contact_id}`, 'PATCH', a.fields, a.api_key));
    case 'get_caller_memory': return ok(await apiCall(`/api/v1/memory/caller?phone=${encodeURIComponent(a.phone)}`, 'GET', undefined, a.api_key));
    case 'search_call_memory': return ok(await apiCall('/api/v1/memory/search', 'POST', { query: a.query, limit: a.limit || 10 }, a.api_key));
    case 'get_call_analytics': {
      const p = new URLSearchParams();
      if (a.from) p.set('from', a.from);
      if (a.to) p.set('to', a.to);
      return ok(await apiCall(`/api/v1/analytics/calls?${p}`, 'GET', undefined, a.api_key));
    }
    case 'list_users': return ok(await apiCall('/api/v1/users', 'GET', undefined, a.api_key));
    case 'create_user': return ok(await apiCall('/api/v1/users', 'POST', { email: a.email, display_name: a.display_name, extension: a.extension, role: a.role || 'agent' }, a.api_key));
    case 'update_user': return ok(await apiCall(`/api/v1/users/${a.user_id}`, 'PATCH', a.fields, a.api_key));
    case 'remove_user': return ok(await apiCall(`/api/v1/users/${a.user_id}`, 'DELETE', undefined, a.api_key));
    case 'search_numbers': {
      const p = new URLSearchParams({ limit: String(a.limit || 10) });
      if (a.area) p.set('area', a.area);
      if (a.prefix) p.set('prefix', a.prefix);
      return ok(await apiCall(`/api/v1/numbers/search?${p}`, 'GET', undefined, a.api_key));
    }
    case 'allocate_number': return ok(await apiCall('/api/v1/numbers', 'POST', { number_id: a.number_id, call_flow_id: a.call_flow_id }, a.api_key));
    case 'list_numbers': return ok(await apiCall('/api/v1/numbers', 'GET', undefined, a.api_key));
    case 'list_call_flows': return ok(await apiCall('/api/v1/flows', 'GET', undefined, a.api_key));
    case 'create_call_flow': return ok(await apiCall('/api/v1/flows', 'POST', { name: a.name, flow_type: a.flow_type, workflow_steps: a.workflow_steps }, a.api_key));
    case 'monitor_call': {
      const { data } = await sb().from('calls').select('room_name').eq('id', a.call_id).single();
      if (!data) return err('Call not found or not active');
      return ok({ room_name: data.room_name, message: 'Join via SONIQ Phone app as monitor', livekit_url: 'wss://livekit.soniqlabs.co.uk' });
    }
    default: return err(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: 'soniq-mcp', version: '1.1.0', description: 'SONIQ Phone System — calls, memory, users, numbers, flows' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: a } = req.params;
    try { return await handleTool(name, a || {}); }
    catch (e) { return err(e.message || 'Tool execution failed'); }
  });
  return server;
}

// ── OAuth 2.0 endpoints ───────────────────────────────────────────────────────
function handleOAuth(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // GET /oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...&code_challenge=...
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const scope = url.searchParams.get('scope') || 'calls:read';
    const state = url.searchParams.get('state') || '';
    const responseType = url.searchParams.get('response_type');
    const codeChallenge = url.searchParams.get('code_challenge') || '';
    const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'plain';

    if (clientId !== OAUTH_CLIENT_ID) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_client' })); return;
    }
    if (responseType !== 'code') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'unsupported_response_type' })); return;
    }

    // Serve an auth page where the user logs in with their SONIQ API key
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`<!DOCTYPE html>
<html>
<head><title>Connect to SONIQ</title>
<style>body{font-family:system-ui;max-width:400px;margin:60px auto;padding:20px}
input{width:100%;padding:10px;margin:8px 0;border:1px solid #ddd;border-radius:6px;box-sizing:border-box}
button{width:100%;padding:12px;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-size:16px}
.logo{font-size:24px;font-weight:700;margin-bottom:20px;background:linear-gradient(135deg,#7c3aed,#db2777);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
</style></head>
<body>
<div class="logo">SONIQ</div>
<h2>Connect AI to your phone system</h2>
<p>Enter your SONIQ API key to grant access.</p>
<form method="POST" action="/oauth/authorize">
  <input type="hidden" name="redirect_uri" value="${redirectUri}">
  <input type="hidden" name="scope" value="${scope}">
  <input type="hidden" name="state" value="${state}">
  <input type="hidden" name="client_id" value="${clientId}">
  <input type="hidden" name="code_challenge" value="${codeChallenge}">
  <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
  <input type="password" name="api_key" placeholder="SONIQ API Key (soniq_live_...)" required>
  <button type="submit">Authorise</button>
</form>
<p style="font-size:12px;color:#666">Your API key is used to verify your identity and is not stored by this server.</p>
</body></html>`);
    return;
  }

  // POST /oauth/authorize — verify API key, issue code
  if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const params = new URLSearchParams(body);
        const apiKey = params.get('api_key');
        const redirectUri = params.get('redirect_uri');
        const scope = params.get('scope') || 'calls:read';
        const state = params.get('state') || '';
        const codeChallenge = params.get('code_challenge') || '';
        const codeChallengeMethod = params.get('code_challenge_method') || 'plain';

        // Verify the API key against Supabase
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        const { data: keyRecord } = await sb()
          .from('api_keys').select('org_id, scopes, is_active').eq('key_hash', keyHash).eq('is_active', true).maybeSingle();

        if (!keyRecord) {
          res.setHeader('Content-Type', 'text/html');
          res.writeHead(401);
          res.end('<h2>Invalid API key. Please check and try again.</h2>');
          return;
        }

        const code = crypto.randomBytes(32).toString('hex');
        oauthCodes.set(code, { org_id: keyRecord.org_id, scope, api_key: apiKey, expires: Date.now() + 600000, codeChallenge, codeChallengeMethod });

        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        if (state) redirect.searchParams.set('state', state);
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', message: e.message }));
      }
    });
    return;
  }

  // POST /oauth/token — exchange code for access token
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        let params;
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          params = JSON.parse(body);
        } else {
          const p = new URLSearchParams(body);
          params = Object.fromEntries(p.entries());
        }

        const { grant_type, code, client_id, client_secret, redirect_uri } = params;

        if (client_id !== OAUTH_CLIENT_ID) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'invalid_client' })); return;
        }
        if (OAUTH_CLIENT_SECRET && client_secret !== OAUTH_CLIENT_SECRET) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'invalid_client' })); return;
        }
        if (grant_type !== 'authorization_code') {
          res.writeHead(400); res.end(JSON.stringify({ error: 'unsupported_grant_type' })); return;
        }

        const codeData = oauthCodes.get(code);
        if (!codeData || codeData.expires < Date.now()) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant' })); return;
        }
        oauthCodes.delete(code);

        // PKCE verification
        if (codeData.codeChallenge) {
          const verifier = params.code_verifier || params['code_verifier'];
          if (!verifier) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code_verifier required' })); return;
          }
          let expectedChallenge;
          if (codeData.codeChallengeMethod === 'S256') {
            expectedChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          } else {
            expectedChallenge = verifier;
          }
          if (expectedChallenge !== codeData.codeChallenge) {
            res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE verification failed' })); return;
          }
        }

        const accessToken = crypto.randomBytes(32).toString('hex');
        oauthTokens.set(accessToken, { org_id: codeData.org_id, scope: codeData.scope, api_key: codeData.api_key, expires: Date.now() + 86400000 });

        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: accessToken,
          token_type: 'bearer',
          expires_in: 86400,
          scope: codeData.scope,
        }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' }));
      }
    });
    return;
  }

  return false; // not handled
}

// ── HTTP SSE Server ───────────────────────────────────────────────────────────
if (USE_HTTP) {
  const transports = new Map();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // RFC 8414 — OAuth 2.0 Authorization Server Metadata
    // Claude.ai and other MCP clients probe this before showing the Connect flow
    if (url.pathname === '/.well-known/oauth-authorization-server' ||
        url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        token_endpoint_auth_methods_supported: ['none'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        scopes_supported: [
          'calls:read', 'calls:write',
          'contacts:read', 'contacts:write',
          'memory:read',
          'users:admin', 'numbers:admin', 'flows:admin',
          'supervisor:write',
        ],
        code_challenge_methods_supported: ['S256', 'plain'],
        service_documentation: 'https://soniqlabs.co.uk/developer',
        ui_locales_supported: ['en-GB'],
      }));
      return;
    }

    // OAuth endpoints
    const oauthHandled = handleOAuth(req, res, url);
    if (oauthHandled !== false) return;

    // Health + metadata
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', service: 'soniq-mcp', version: '1.1.0',
        tools: TOOLS.length,
        sse_url: `${BASE_URL}/sse`,
        oauth_authorize: `${BASE_URL}/oauth/authorize`,
        oauth_token: `${BASE_URL}/oauth/token`,
      }));
      return;
    }

    // MCP SSE endpoint
    if (url.pathname === '/sse') {
      const server = createMcpServer();
      const transport = new SSEServerTransport('/message', res);
      transports.set(transport.sessionId, { server, transport });
      res.on('close', () => transports.delete(transport.sessionId));
      await server.connect(transport);
      return;
    }

    // MCP message endpoint
    if (url.pathname === '/message' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        const sessionId = req.headers['mcp-session-id'];
        const entry = sessionId ? transports.get(sessionId) : [...transports.values()][0];
        if (!entry) { res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return; }
        await entry.transport.handlePostMessage(req, res, JSON.parse(body));
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[SONIQ MCP] HTTP SSE server on port ${PORT}`);
    console.log(`[SONIQ MCP] SSE endpoint: ${BASE_URL}/sse`);
    console.log(`[SONIQ MCP] OAuth: ${BASE_URL}/oauth/authorize`);
    console.log(`[SONIQ MCP] Tools: ${TOOLS.length}`);
  });
} else {
  // stdio transport
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[SONIQ MCP] Running on stdio');
}
