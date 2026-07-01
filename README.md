# @sailingnaturali/signalk-ntfy-relay

Relay [Signal K](https://signalk.org) notifications (alarms) to an
[ntfy](https://ntfy.sh) topic — so a man-overboard, depth/wind/battery alarm, or
any other notification reaches your phone, independent of any chartplotter or
shoreside server.

**Zero runtime dependencies.** Notifications are read in-process via the Signal K
subscription manager; ntfy is reached with Node's built-in `https`.

## How it works

- Subscribes to `notifications.*` and **edge-triggers**: it pushes once when an
  alarm becomes active, not repeatedly while it persists.
- Forwards notifications at or above a configurable severity (`warn` by default).
- Maps Signal K severity to ntfy **priority** and **tags**:

  | Signal K state | ntfy priority | tag |
  |----------------|---------------|-----|
  | `emergency` | 5 (max) | 🆘 `sos` |
  | `alarm` | 4 (high) | 🚨 `rotating_light` |
  | `warn` | 3 (default) | ⚠️ `warning` |
  | `alert` | 2 (low) | ℹ️ `information_source` |
  | cleared (`normal`) | 1 (min) | ✅ `white_check_mark` |

- Appends the vessel position to the message when known.

## Configuration

| Setting | Default | Notes |
|---------|---------|-------|
| `server` | `https://ntfy.sh` | Set to your self-hosted ntfy server |
| `topic` | *(required)* | The ntfy topic to publish to |
| `token` | *(empty)* | `Authorization: Bearer` token (self-hosted/ACL) |
| `minState` | `warn` | Minimum severity to forward |
| `notifyOnClear` | `true` | Also send a message when an alarm resolves |
| `includePosition` | `true` | Append `lat, lon` to the message |
| `healthCheckIntervalHours` | `24` | Proactively probe the ntfy path (`/v1/account`); `0` disables. Token-only |
| `failureThreshold` | `3` | Consecutive failures before raising the delivery-path alarm |

## Delivery-path health check

The push path can break silently — an expired/revoked token, an ACL change, or a
server outage means alarms stop reaching the phone with nothing to show for it,
and you don't find out until the next real alarm fails to deliver. To close that
blind spot the relay watches its own health:

- **Proactively** — every `healthCheckIntervalHours` it verifies the token/server
  via a read-only `/v1/account` probe (catches an expired token even when no
  alarms are firing).
- **Reactively** — it counts consecutive send failures.

After `failureThreshold` consecutive failures it raises
`notifications.ntfyRelay.deliveryFailed` (state `alert`) under *self*. That's a
SignalK notification, so it surfaces on the dashboard and voice pipeline —
channels **independent of the phone that's down** — and it is never itself
forwarded to ntfy (no loop through the failing path). A success clears it.

## Setup

1. Install from the Signal K app store (category: Notifications), or drop this
   folder into the server's `node_modules`.
2. Pick a hard-to-guess topic (anyone who knows a public-server topic can read it),
   e.g. `naturali-alarms-7f3a`.
3. Install the ntfy app on your phone and subscribe to that topic.
4. Configure the plugin with the topic and enable it.

Test it by raising a notification, e.g. a man-overboard via the Signal K v2 API:

```bash
curl -X POST http://<signalk-host>:3000/signalk/v2/api/notifications/mob
```

## Diagnostics

`scripts/ntfy-doctor.js` checks the ntfy delivery leg directly, so a silent break
(expired access token, reserved-topic ACL) surfaces without waiting for a real
alarm — the failure mode that can take the whole alarm-to-phone path dark unnoticed.

```bash
# verify the access token (read-only; publishes nothing)
npm run ntfy-doctor -- --config /home/node/.signalk/plugin-config-data/signalk-ntfy-relay.json

# end-to-end: publish a labelled test message and confirm it landed
NTFY_TOPIC=my-alarms NTFY_TOKEN=tk_xxx npm run ntfy-doctor -- test

# list the topic's messages from the last 10 minutes
npm run ntfy-doctor -- poll --server https://ntfy.sh --topic my-alarms
```

Config resolves in the order: CLI flag → `--config <plugin-config.json>` → env
(`NTFY_SERVER`/`NTFY_TOPIC`/`NTFY_TOKEN`) → default. The token is never printed.

## License

MIT
