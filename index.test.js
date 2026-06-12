const test = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('./index.js');
const { rank, isActive, shouldForward } = createPlugin._internal;

test('rank orders the SignalK severity ladder', () => {
  assert.ok(rank('emergency') > rank('alarm'));
  assert.ok(rank('alarm') > rank('warn'));
  assert.ok(rank('warn') > rank('alert'));
  assert.equal(rank('bogus'), -1);
});

test('isActive: nominal/normal are inactive, the rest active', () => {
  assert.equal(isActive('normal'), false);
  assert.equal(isActive('nominal'), false);
  assert.equal(isActive(undefined), false);
  assert.equal(isActive('warn'), true);
  assert.equal(isActive('emergency'), true);
});

test('shouldForward: active and >= minState', () => {
  assert.equal(shouldForward('emergency', 'warn'), true);
  assert.equal(shouldForward('warn', 'warn'), true);
  assert.equal(shouldForward('alert', 'warn'), false); // below min
  assert.equal(shouldForward('normal', 'warn'), false); // inactive
  assert.equal(shouldForward('alarm', 'alarm'), true);
});

const { priorityFor, tagsFor } = createPlugin._internal;

test('priorityFor maps severity to ntfy 1-5', () => {
  assert.equal(priorityFor('emergency'), '5');
  assert.equal(priorityFor('alarm'), '4');
  assert.equal(priorityFor('warn'), '3');
  assert.equal(priorityFor('alert'), '2');
  assert.equal(priorityFor('normal'), '1');   // cleared
  assert.equal(priorityFor('nominal'), '1');
});

test('tagsFor maps severity to an emoji shortcode', () => {
  assert.equal(tagsFor('emergency'), 'sos');
  assert.equal(tagsFor('alarm'), 'rotating_light');
  assert.equal(tagsFor('warn'), 'warning');
  assert.equal(tagsFor('alert'), 'information_source');
  assert.equal(tagsFor('normal'), 'white_check_mark'); // cleared
});

const { buildRequest, headerSafe } = createPlugin._internal;

test('headerSafe collapses CR/LF and control chars to a single space', () => {
  assert.equal(headerSafe('EMERGENCY: a\r\nX-Evil: 1'), 'EMERGENCY: a X-Evil: 1');
  assert.equal(headerSafe('a\tb'), 'a b');
});

test('headerSafe caps header length', () => {
  assert.equal(headerSafe('x'.repeat(500)).length, 256);
});

test('buildRequest neutralizes a CRLF-bearing notification path in the Title header', () => {
  const r = buildRequest({ path: 'mob\r\nX-Evil: pwned', state: 'emergency' }, undefined, {
    topic: 't',
  });
  assert.doesNotMatch(r.headers.Title, /[\r\n]/);
  assert.equal(r.headers.Title, 'EMERGENCY: mob X-Evil: pwned');
});

const N = { path: 'mob.1', state: 'emergency', message: 'Man overboard' };
const POS = { latitude: 48.7621, longitude: -123.052 };

test('buildRequest composes url, headers and body', () => {
  const r = buildRequest(N, POS, { server: 'https://ntfy.sh', topic: 'boat' });
  assert.equal(r.url, 'https://ntfy.sh/boat');
  assert.equal(r.headers.Title, 'EMERGENCY: mob.1');
  assert.equal(r.headers.Priority, '5');
  assert.equal(r.headers.Tags, 'sos');
  assert.ok(r.body.startsWith('Man overboard'));
  assert.match(r.body, /48\.76210, -123\.05200/); // position appended
  assert.equal(r.headers.Authorization, undefined); // no token
});

test('buildRequest trims trailing slash and adds auth + omits position', () => {
  const r = buildRequest(N, undefined, {
    server: 'https://ntfy.example.com/', topic: 't', token: 'tk_abc',
  });
  assert.equal(r.url, 'https://ntfy.example.com/t');
  assert.equal(r.headers.Authorization, 'Bearer tk_abc');
  assert.equal(r.body, 'Man overboard'); // no position line
});

test('buildRequest honors includePosition:false and defaults server', () => {
  const r = buildRequest(N, POS, { topic: 't', includePosition: false });
  assert.equal(r.url, 'https://ntfy.sh/t');
  assert.equal(r.body, 'Man overboard');
});

test('buildRequest falls back to path when no message', () => {
  const r = buildRequest({ path: 'mob.1', state: 'emergency' }, undefined, { topic: 't' });
  assert.equal(r.body, 'mob.1');
});

test('buildRequest URL-encodes the topic', () => {
  const r = buildRequest(N, undefined, { topic: 'a b/c' });
  assert.equal(r.url, 'https://ntfy.sh/a%20b%2Fc');
});

test('priorityFor/tagsFor fall back to warn-level for an unknown active state', () => {
  const { priorityFor, tagsFor } = createPlugin._internal;
  assert.equal(priorityFor('weird'), '3');
  assert.equal(tagsFor('weird'), 'warning');
});

// Build a mock app that captures the delta callback and serves a position.
function makeApp(position) {
  const captured = {};
  const app = {
    getSelfPath: (p) =>
      p === 'navigation.position' && position ? { value: position } : undefined,
    subscriptionmanager: {
      subscribe: (sub, unsub, onErr, onDelta) => {
        captured.sub = sub;
        captured.onDelta = onDelta;
      },
    },
    error: () => {},
    debug: () => {},
  };
  return { app, captured };
}

// Run a plugin with an injected send; return the list of sent requests + a
// helper to feed a notification delta.
function runRelay(options, position) {
  const sent = [];
  const { app, captured } = makeApp(position);
  const plugin = createPlugin(app, { send: (req) => sent.push(req) });
  plugin.start(options);
  const feed = (path, value) =>
    captured.onDelta({ updates: [{ values: [{ path, value }] }] });
  return { sent, feed, captured, plugin };
}

test('subscribes to notifications.* with instant policy', () => {
  const { captured } = runRelay({ topic: 't' });
  assert.equal(captured.sub.subscribe[0].path, 'notifications.*');
  assert.equal(captured.sub.subscribe[0].policy, 'instant');
});

test('forwards an active alarm >= minState once', () => {
  const { sent, feed } = runRelay({ topic: 't' }, { latitude: 48.76, longitude: -123.05 });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Title, 'EMERGENCY: mob.1');
  assert.match(sent[0].body, /48\.76000, -123\.05000/);
});

test('edge-triggers: repeated same-state deltas send once', () => {
  const { sent, feed } = runRelay({ topic: 't' });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  assert.equal(sent.length, 1);
});

test('drops inactive and below-minState notifications', () => {
  const { sent, feed } = runRelay({ topic: 't', minState: 'warn' });
  feed('notifications.x', { state: 'normal', message: 'ok' });
  feed('notifications.y', { state: 'alert', message: 'fyi' });
  assert.equal(sent.length, 0);
});

test('ignores non-notification paths', () => {
  const { sent, feed } = runRelay({ topic: 't' });
  feed('environment.depth.belowKeel', { value: 2 });
  assert.equal(sent.length, 0);
});

test('a throwing send is caught and does not propagate', () => {
  const { app, captured } = makeApp();
  const plugin = createPlugin(app, {
    send: () => {
      throw new Error('network boom');
    },
  });
  plugin.start({ topic: 't' });
  assert.doesNotThrow(() =>
    captured.onDelta({
      updates: [{ values: [{ path: 'notifications.mob.1', value: { state: 'emergency' } }] }],
    })
  );
});

test('sends a cleared message when an active alarm resolves', () => {
  const { sent, feed } = runRelay({ topic: 't' });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  feed('notifications.mob.1', { state: 'normal', message: 'MOB resolved' });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers.Priority, '1');
  assert.equal(sent[1].headers.Tags, 'white_check_mark');
  assert.equal(sent[1].headers.Title, 'NORMAL: mob.1');
});

test('notifyOnClear:false suppresses the cleared message', () => {
  const { sent, feed } = runRelay({ topic: 't', notifyOnClear: false });
  feed('notifications.mob.1', { state: 'emergency', message: 'MOB' });
  feed('notifications.mob.1', { state: 'normal', message: 'MOB resolved' });
  assert.equal(sent.length, 1);
});

test('does not send a clear for an alarm that was never active', () => {
  const { sent, feed } = runRelay({ topic: 't' });
  feed('notifications.depth', { state: 'normal', message: 'fine' });
  assert.equal(sent.length, 0);
});

const http = require('node:http');

test('defaultSend POSTs to the ntfy server with mapped headers and body', async () => {
  let server;
  const received = await new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.end('ok');
        resolve({ method: req.method, url: req.url, headers: req.headers, body });
      });
    });
    server.on('error', reject);
    // Fail fast (and cleanly) if the stub sends nothing.
    setTimeout(() => reject(new Error('ntfy server received no request')), 2000);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const { app, captured } = makeApp({ latitude: 48.76, longitude: -123.05 });
      const plugin = createPlugin(app); // no deps -> real defaultSend
      plugin.start({ topic: 'boat', server: `http://127.0.0.1:${port}` });
      captured.onDelta({
        updates: [
          { values: [{ path: 'notifications.mob.1', value: { state: 'emergency', message: 'MOB' } }] },
        ],
      });
    });
  }).finally(() => server && server.close());
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/boat');
  assert.equal(received.headers.title, 'EMERGENCY: mob.1');
  assert.equal(received.headers.priority, '5');
  assert.equal(received.headers.tags, 'sos');
  assert.match(received.body, /MOB/);
  assert.match(received.body, /48\.76000, -123\.05000/);
});

test('schema exposes the documented config fields with defaults', () => {
  const plugin = createPlugin({ error() {} });
  const p = plugin.schema.properties;
  assert.equal(p.server.default, 'https://ntfy.sh');
  assert.equal(p.minState.default, 'warn');
  assert.deepEqual(p.minState.enum, ['alert', 'warn', 'alarm', 'emergency']);
  assert.equal(p.notifyOnClear.default, true);
  assert.equal(p.includePosition.default, true);
  assert.ok(p.topic, 'topic field present');
});
