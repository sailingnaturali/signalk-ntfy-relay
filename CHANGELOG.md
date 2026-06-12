# Changelog

All notable changes to `@sailingnaturali/signalk-ntfy-relay` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2]

### Security

- Sanitise the outbound `Title` header before sending to ntfy. The title is
  built from the notification path and state; a CR/LF in a path could smuggle
  extra headers into the request or trip Node's `ERR_INVALID_CHAR` and silently
  drop the alarm push. Control-character runs now collapse to a single space and
  the title is length-capped. Defence-in-depth on in-process but untrusted data.

## [0.1.1]

### Added

- Initial published release. Watches `notifications.*`, edge-triggers on state
  change, and POSTs active alarms at or above a configurable severity to an ntfy
  topic. Zero runtime dependencies. Optional cleared-alarm messages and appended
  vessel position.
