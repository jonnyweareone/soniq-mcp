# SONIQ MCP Server — Production Deployment Guide

Tested on Ubuntu 22.04 LTS (Vultr VPS, Node 20).

## Prerequisites

- Node.js 20+
- nginx with SSL
- SONIQ orchestrator running on port 3100
- Supabase project with `api_keys` table

## 1. Clone and install

```bash
cd /opt/soniq
git clone https://github.com/jonnyweareone/soniq-mcp.git mcp
cd mcp
npm install
cp .env.example .env
# Edit .env with your values
```

## 2. Systemd service

```ini
# /etc/systemd/system/soniq-mcp.service
[Unit]
Description=SONIQ MCP Server
After=network.target soniq-orchestrator.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/soniq/mcp
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=MCP_TRANSPORT=http
Environment=MCP_PORT=3200
EnvironmentFile=/opt/soniq/mcp/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable soniq-mcp
systemctl start soniq-mcp
```

## 3. nginx reverse proxy

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/mcp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.yourdomain.com/privkey.pem;

    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Headers "content-type, mcp-session-id, authorization";

    location / {
        if ($request_method = OPTIONS) { return 204; }
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

## 4. DNS

Add an A record: `mcp.yourdomain.com → your-server-ip`

## 5. SSL

```bash
certbot certonly --webroot -w /var/www/html \
  -d mcp.yourdomain.com --non-interactive --agree-tos \
  --email admin@yourdomain.com
```

## 6. Verify

```bash
curl https://mcp.yourdomain.com/health
# {"status":"ok","service":"soniq-mcp","tools":24,"version":"1.1.0"}
```

## Environment variables

| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for admin DB access |
| `SONIQ_API_BASE` | SONIQ REST API base URL (default: `http://127.0.0.1:3100`) |
| `MCP_PORT` | HTTP server port (default: 3200) |
| `MCP_TRANSPORT` | `http` or `stdio` |
| `OAUTH_CLIENT_ID` | OAuth client ID for Anthropic Directory |
| `OAUTH_CLIENT_SECRET` | OAuth client secret |
| `BASE_URL` | Public URL of this MCP server |
