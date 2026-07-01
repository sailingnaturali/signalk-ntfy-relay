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
    else { console.error(`unknown command: ${cmd}`); code = 2; }
    process.exit(code);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(1);
  }
}

main();
