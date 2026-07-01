#!/usr/bin/env node
'use strict';

/*
 * ntfy-doctor.js — diagnose the ntfy delivery path for signalk-ntfy-relay.
 *
 * Answers "is the phone-alarm path actually working?" without waiting for a real
 * alarm. Talks to ntfy directly (this checks the ntfy leg, not the SignalK →
 * relay leg), so an expired token or reserved-topic ACL surfaces immediately —
 * the failure mode that silently took the whole alarm-to-phone path dark.
 *
 * Usage:
 *   node scripts/ntfy-doctor.js [command] [options]
 *
 * Commands:
 *   check   (default) Verify the access token via GET /v1/account (read-only,
 *                     publishes nothing). 200 = token valid, 401 = expired/revoked.
 *   test              Publish a labelled test message to the topic, then poll to
 *                     confirm it landed (a real end-to-end delivery check).
 *   poll              List messages published to the topic in the last 10 minutes.
 *   mint              Create a new access token via POST /v1/account/token
 *                     (authenticates with the existing token). With --config it
 *                     rotates the token into that config file (backup written);
 *                     otherwise it prints the new token. Tune with --label and
 *                     --expires (never | <days>, default never).
 *
 * Config (precedence: CLI flag > --config file > env > default):
 *   --server <url>    ntfy base URL           (env NTFY_SERVER, default https://ntfy.sh)
 *   --topic <name>    ntfy topic              (env NTFY_TOPIC)
 *   --token <tk_...>  access token            (env NTFY_TOKEN)
 *   --config <path>   read server/topic/token from a plugin-config-data JSON,
 *                     e.g. ~/.signalk/plugin-config-data/signalk-ntfy-relay.json
 *
 * Examples:
 *   node scripts/ntfy-doctor.js --config /home/node/.signalk/plugin-config-data/signalk-ntfy-relay.json
 *   NTFY_TOPIC=my-alarms NTFY_TOKEN=tk_xxx node scripts/ntfy-doctor.js test
 *   node scripts/ntfy-doctor.js poll --server https://ntfy.sh --topic my-alarms
 *
 * The token is never printed.
 */

const fs = require('node:fs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function resolveConfig(args) {
  let fromFile = {};
  if (args.config) {
    const cfg = JSON.parse(fs.readFileSync(args.config, 'utf8')).configuration || {};
    fromFile = { server: cfg.server, topic: cfg.topic, token: cfg.token };
  }
  const pick = (flag, envKey, fileKey, dflt) =>
    args[flag] ?? process.env[envKey] ?? fromFile[fileKey] ?? dflt;
  return {
    server: (pick('server', 'NTFY_SERVER', 'server', 'https://ntfy.sh')).replace(/\/+$/, ''),
    topic: pick('topic', 'NTFY_TOPIC', 'topic', undefined),
    token: pick('token', 'NTFY_TOKEN', 'token', '') || '',
  };
}

// Minimal request helper — picks http/https by protocol, like the plugin itself.
function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(urlStr);
  const lib = url.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function check({ server, token }) {
  if (!token) {
    console.log(`server: ${server}`);
    console.log('token:  (none) — anonymous publishing only works on unreserved topics');
    return 0;
  }
  const { status, body } = await request(`${server}/v1/account`, { headers: authHeaders(token) });
  let role = '-';
  try { const j = JSON.parse(body); role = j.role || (j.tier && j.tier.name) || '-'; } catch (e) {}
  console.log(`server: ${server}`);
  console.log(`/v1/account: ${status}${role !== '-' ? ` (role: ${role})` : ''}`);
  if (status === 200) { console.log('✓ token valid'); return 0; }
  if (status === 401) { console.log('✗ token invalid/expired/revoked — mint a new one on ntfy.sh'); return 1; }
  console.log('✗ unexpected status'); return 1;
}

async function poll({ server, topic, token }, sinceLabel = '10m', quiet = false) {
  const { status, body } = await request(
    `${server}/${encodeURIComponent(topic)}/json?poll=1&since=${sinceLabel}`,
    { headers: authHeaders(token) }
  );
  const msgs = (body.trim() ? body.trim().split('\n') : [])
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter((m) => m && m.event === 'message');
  if (!quiet) {
    console.log(`poll: ${status} — ${msgs.length} message(s) in last ${sinceLabel}`);
    for (const m of msgs.slice(-8)) {
      console.log(`  ${new Date(m.time * 1000).toISOString()} | ${m.title || '(no title)'} | ${(m.message || '').slice(0, 60)}`);
    }
  }
  return { status, msgs };
}

async function test({ server, topic, token }) {
  const marker = `ntfy-doctor ${new Date().toISOString()}`;
  const { status } = await request(`${server}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    headers: { ...authHeaders(token), Title: 'ntfy-doctor test — please ignore' },
    body: marker,
  });
  console.log(`publish: ${status}`);
  if (status !== 200) {
    console.log(status === 401 || status === 403
      ? '✗ rejected — token invalid or lacks write access to this (reserved) topic'
      : '✗ publish failed');
    return 1;
  }
  const { msgs } = await poll({ server, topic, token }, '1m', true);
  const landed = msgs.some((m) => (m.message || '').includes(marker));
  console.log(landed ? '✓ test message published and confirmed on the topic' : '⚠ published (200) but not seen on poll yet');
  return landed ? 0 : 1;
}

async function mint({ server, token }, args) {
  if (!token) {
    console.error('error: mint needs an existing token to authenticate (--token, NTFY_TOKEN, or --config)');
    return 2;
  }
  const label = args.label || 'signalk-ntfy-relay';
  const expiresArg = args.expires || 'never';
  let expires = 0; // 0 = never
  if (expiresArg !== 'never') {
    const days = Number(expiresArg);
    if (!Number.isFinite(days) || days <= 0) {
      console.error('error: --expires must be "never" or a positive number of days');
      return 2;
    }
    expires = Math.floor(Date.now() / 1000) + Math.round(days * 86400);
  }

  const body = JSON.stringify({ label, expires });
  const res = await request(`${server}/v1/account/token`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (res.status !== 200) {
    console.log(`mint: ${res.status}`);
    console.log(res.status === 401
      ? '✗ existing token cannot create tokens (invalid or insufficient scope)'
      : '✗ mint failed');
    return 1;
  }
  let tok, exp;
  try { const j = JSON.parse(res.body); tok = j.token; exp = j.expires; } catch (e) {}
  if (!tok) { console.log('✗ no token in response'); return 1; }

  // Verify the new token works before we rely on it.
  const ver = await request(`${server}/v1/account`, { headers: authHeaders(tok) });
  if (ver.status !== 200) { console.log(`✗ new token failed verification (${ver.status})`); return 1; }
  const expiryLabel = exp == null || exp === 0 ? 'never' : new Date(exp * 1000).toISOString();

  if (args.config) {
    const conf = JSON.parse(fs.readFileSync(args.config, 'utf8'));
    conf.configuration = conf.configuration || {};
    const bak = `${args.config}.bak-${Date.now()}`;
    fs.writeFileSync(bak, JSON.stringify(conf, null, 2));
    conf.configuration.token = tok;
    fs.writeFileSync(args.config, JSON.stringify(conf, null, 2));
    console.log(`✓ minted ${tok.slice(0, 5)}… (expires: ${expiryLabel}, label: "${label}")`);
    console.log(`✓ rotated into ${args.config} — restart the plugin to load it (backup: ${bak})`);
  } else {
    console.log(`✓ minted token (expires: ${expiryLabel}, label: "${label}"):`);
    console.log(`  ${tok}`);
    console.log('  keep this secret — set it as the plugin token (or re-run with --config to rotate it in place)');
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'check';
  const cfg = resolveConfig(args);
  const needsTopic = cmd === 'test' || cmd === 'poll';
  if (needsTopic && !cfg.topic) {
    console.error('error: no topic — pass --topic, set NTFY_TOPIC, or use --config <plugin-config.json>');
    process.exit(2);
  }
  try {
    let code;
    if (cmd === 'check') code = await check(cfg);
    else if (cmd === 'poll') { await poll(cfg); code = 0; }
    else if (cmd === 'test') code = await test(cfg);
    else if (cmd === 'mint') code = await mint(cfg, args);
    else { console.error(`unknown command: ${cmd}`); code = 2; }
    process.exit(code);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

main();
