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

- `/auth claude` starts `claude auth login --claudeai`.
- `/auth codex` starts `codex login --device-auth`.
- `/auth status` reports active flows and each provider's authenticated state.
  If a provider is not authenticated, the reply includes the matching login
  command, for example `/auth claude` or `/auth codex`.
- `/auth cancel` stops active authentication flows.
- `/auth input <one-time-code>` sends a short one-time code to the active flow
  and deletes the Telegram message best-effort.

Auth commands are intercepted before normal session routing, attachments, and
speech-to-text handling. They are not delivered to the normal message handler.
The connector does not accept provider tokens, add HTTP endpoints, or proxy
arbitrary callbacks. Post-exit verification runs only fixed status commands and
reports generic success or failure.
