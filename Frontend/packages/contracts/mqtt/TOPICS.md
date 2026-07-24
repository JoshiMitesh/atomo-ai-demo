## ATOMO MQTT Topic Design (v1)

### Identity
- `atomo/v1/devices/{deviceId}/hello`
  - slave → master: first contact + fingerprint
- `atomo/v1/devices/{deviceId}/approved`
  - master → slave: trust established + issued device config

### Telemetry (offline-first)
- `atomo/v1/devices/{deviceId}/heartbeat`
  - slave → master: every 10-30s (health snapshot pointer)
- `atomo/v1/devices/{deviceId}/health`
  - slave → master: periodic metrics batch

### Alerts / Events
- `atomo/v1/devices/{deviceId}/alerts`
  - slave → master: alert events (buffer locally; replay on reconnect)
- `atomo/v1/devices/{deviceId}/events`
  - slave → master: non-alert events

### Commands
- `atomo/v1/devices/{deviceId}/commands`
  - master → slave: OTA, config, model deploy
- `atomo/v1/devices/{deviceId}/command-acks`
  - slave → master: command completion/failure

### Cameras
- `atomo/v1/devices/{deviceId}/cameras/status`
  - slave → master: camera health & stream status

### Security
- All topics require mTLS in production.
- Device certificate CN/SAN must match deviceId + serial.
- Master issues short-lived JWT for local UI, slaves validate offline.

