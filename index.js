/*
 * signalk-ntfy-relay — relay SignalK notifications to ntfy.
 *
 * Watches notifications.* in-process, edge-triggers on state change, and POSTs
 * active alarms (>= a configurable severity) to an ntfy topic via Node's
 * built-in https/http. Zero runtime dependencies, so it mounts read-only.
 *
 * The factory takes an optional second arg `deps` so tests can inject a fake
 * `send`; SignalK calls it with just (app), using the real network sender.
 */
const SEVERITY = { nominal: 0, normal: 1, alert: 2, warn: 3, alarm: 4, emergency: 5 };
const INACTIVE = new Set(['nominal', 'normal']);

function rank(state) {
  return state in SEVERITY ? SEVERITY[state] : -1;
}
function isActive(state) {
  return state != null && !INACTIVE.has(state);
}
function shouldForward(state, minState) {
  return isActive(state) && rank(state) >= rank(minState);
}

const PRIORITY = { emergency: '5', alarm: '4', warn: '3', alert: '2' };
const TAGS = {
  emergency: 'sos',
  alarm: 'rotating_light',
  warn: 'warning',
  alert: 'information_source',
};

// Inactive (cleared) states get the min-priority "resolved" treatment.
function priorityFor(state) {
  return isActive(state) ? (PRIORITY[state] || '3') : '1';
}
function tagsFor(state) {
  return isActive(state) ? (TAGS[state] || 'warning') : 'white_check_mark';
}

// HTTP header values must be a single line. The notification path and state
// are in-process data, but another plugin (or replayed/injected delta) could
// put a CR/LF in a path; left raw it would either smuggle extra response
// headers into the ntfy request or trip Node's ERR_INVALID_CHAR and silently
// drop the alarm push. Collapse control runs to a space and cap the length so
// a pathological path can't bloat the request line.
function headerSafe(value, max = 256) {
  return String(value)
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .slice(0, max);
}

// Compose the ntfy HTTP request (pure — no I/O). Returns {url, headers, body}.
function buildRequest(n, position, options) {
  const base = (options.server || 'https://ntfy.sh').replace(/\/+$/, '');
  // Encode the topic so a stray space/slash can't break the path or smuggle in
  // extra path segments (ntfy topics are [A-Za-z0-9_-], but be defensive).
  const url = `${base}/${encodeURIComponent(options.topic)}`;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: headerSafe(`${String(n.state).toUpperCase()}: ${n.path}`),
    Priority: priorityFor(n.state),
    Tags: tagsFor(n.state),
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body = n.message || n.path;
  if (
    options.includePosition !== false &&
    position &&
    typeof position.latitude === 'number' &&
    typeof position.longitude === 'number'
  ) {
    body += `\n@ ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
  }
  return { url, headers, body };
}

const https = require('https');
const http = require('http');
const { URL } = require('url');

// The only I/O boundary. Fire-and-forget POST to ntfy; never throws — any
// failure is logged via app.error so one bad push can't stall other alarms.
function defaultSend({ url, headers, body }, app) {
  try {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers }, (res) => {
      res.resume(); // drain
      if (res.statusCode >= 300) app.error(`ntfy responded ${res.statusCode}`);
    });
    req.on('error', (e) => app.error(`ntfy post failed: ${e.message}`));
    req.setTimeout(5000, () => req.destroy(new Error('ntfy timeout')));
    req.write(body);
    req.end();
  } catch (e) {
    app.error(`ntfy send error: ${e.message}`);
  }
}

module.exports = function (app, deps) {
  const send = (deps && deps.send) || defaultSend;
  const plugin = {
    id: 'signalk-ntfy-relay',
    name: 'ntfy notification relay',
    description: 'Relay SignalK notifications (alarms) to an ntfy topic.',
  };

  plugin.schema = {
    type: 'object',
    required: ['topic'],
    properties: {
      server: {
        type: 'string',
        title: 'ntfy server base URL',
        default: 'https://ntfy.sh',
      },
      topic: {
        type: 'string',
        title: 'ntfy topic to publish alarms to',
      },
      token: {
        type: 'string',
        title: 'Access token (optional, for self-hosted/ACL servers)',
        default: '',
      },
      minState: {
        type: 'string',
        title: 'Minimum severity to forward',
        enum: ['alert', 'warn', 'alarm', 'emergency'],
        default: 'warn',
      },
      notifyOnClear: {
        type: 'boolean',
        title: 'Send a message when an alarm clears',
        default: true,
      },
      includePosition: {
        type: 'boolean',
        title: 'Append vessel position to the message',
        default: true,
      },
    },
  };

  let unsubscribes = [];
  let lastState = new Map();

  function position() {
    const node = app.getSelfPath('navigation.position');
    if (node == null) return undefined;
    const v = typeof node === 'object' && 'value' in node ? node.value : node;
    return v && typeof v.latitude === 'number' ? v : undefined;
  }

  function onDelta(delta, options) {
    (delta.updates || []).forEach((u) =>
      (u.values || []).forEach((v) => {
        if (!v.path || !v.path.startsWith('notifications.')) return;
        const state = v.value && v.value.state;
        const path = v.path.slice('notifications.'.length);
        const prev = lastState.get(path);
        if (state === prev) return; // edge-trigger: only act on change
        lastState.set(path, state);
        const min = options.minState || 'warn';
        const message = (v.value && v.value.message) || undefined;
        if (shouldForward(state, min)) {
          send(buildRequest({ path, state, message }, position(), options), app);
        } else if (
          !isActive(state) &&
          isActive(prev) &&
          options.notifyOnClear !== false
        ) {
          send(
            buildRequest({ path, state: state || 'normal', message }, position(), options),
            app
          );
        }
      })
    );
  }

  plugin.start = function (options) {
    options = options || {};
    lastState = new Map();
    if (!options.topic) {
      app.error('signalk-ntfy-relay: no ntfy topic configured — idling');
      return;
    }
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [{ path: 'notifications.*', policy: 'instant' }],
      },
      unsubscribes,
      (err) => app.error(err),
      (delta) => {
        try {
          onDelta(delta, options);
        } catch (e) {
          app.error(`signalk-ntfy-relay: ${e.message}`);
        }
      }
    );
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    lastState = new Map();
  };

  return plugin;
};

// Pure helpers, hung off the factory for unit tests.
module.exports._internal = { rank, isActive, shouldForward, priorityFor, tagsFor, buildRequest, headerSafe };
