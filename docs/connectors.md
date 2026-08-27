# Connectors

## Telegram Authentication

Telegram auth commands are disabled unless the Telegram connector config enables
them explicitly:

```yaml
connectors:
  telegram:
    botToken: ...
    allowFrom:
      - 123456789
    telegramAuth:
      enabled: true
      ownerUserIds:
        - 123456789
      flowTtlSeconds: 600
```

`ownerUserIds` must contain numeric Telegram user IDs. It does not replace the
normal `allowFrom` gate; keep both restricted to the intended owner. Usernames
are not an authentication boundary. Replace the example ID with your own.

Supported private-chat commands:

- `/auth_claude` starts Claude authentication.
- `/auth_codex` starts Codex device authentication.
- `/auth_status` reports active flows and each provider's authenticated state.
- `/auth_cancel` stops active authentication flows.
- `/auth_input <code>` sends a short one-time code to the active flow and
  deletes the Telegram message best-effort. For Claude, a loopback callback URL
  or the browser's direct `code#state` value is accepted and forwarded intact.
- The space forms (`/auth claude`, `/auth codex`, `/auth status`,
  `/auth cancel`, and `/auth input <code>`) are also supported.

Auth commands are intercepted before normal session routing, attachments, and
speech-to-text handling. They are not delivered to the normal message handler.
The connector does not accept provider tokens, add HTTP endpoints, or proxy
arbitrary callbacks. Post-exit verification runs only fixed status commands and
reports generic success or failure.
