# Changelog

## 0.5.2

External pi now runs with the user's own Pi home; compaction settings move to the Agent workspace's `.pi/settings.json`; 0.5.0/0.5.1 started external pi with an empty agent dir and saw no logins. Stock pi 0.84.x does not emit `get_state.compactionCapabilities` (that handshake only existed for the bundled build); Larkin accepts the absence and keeps native compaction via the workspace settings file, while a present handshake must still match exactly.

## 0.5.1

External pi is accepted at 0.84.2 or newer instead of exactly 0.84.2; 0.5.0 refused newer pi and left every migrated Agent not ready.

## 0.5.0

BREAKING — builtin Pi is removed. Larkin supports only externally installed `pi`, `codex`, and `claude`. If the selected runtime is not installed, setup, runtime switch, and readiness fail with an explicit missing-install message.

Existing builtin-pi Agents migrate to external `pi` on first config load and keep their stored model. Larkin-owned Pi credential directories (`providers/pi/<agentId>/`) are deleted during that migration. Users must install and log in to `pi`, `codex`, or `claude` themselves.

The `pi-auth` and `pi-distribution` commands are removed. Invoking them returns the standard unknown-command error. Dashboard Provider Credentials and `/api/pi-auth/*` are gone.

`larkin setup --model <id>` again stores a catalog-validated model for the chosen runtime.
