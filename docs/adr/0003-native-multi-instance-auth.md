# ADR 0003: Native authentication is isolated by gateway profile

- Status: accepted
- Date: 2026-08-18
- Decision owners: platform team

## Context

A native application can connect to several Jinn gateways. One global cookie,
query cache, WebSocket, or instance identity allows data from gateway A to
appear after switching to gateway B. Host-only credential keys also collide
when two gateways use different ports.

## Decision

Native gateway profiles are keyed by exact canonical origin, including port.
The versioned profile roster stores non-secret metadata and the last active
profile in bundled-app local storage. Credentials remain in the operating
system store under a SHA-256 account key derived from that exact origin.

Switching is a transaction:

1. Validate the destination using its own transport and credential.
2. Cancel and clear gateway-scoped query state.
3. Increment a monotonic generation and close old sockets.
4. Commit the new active profile and remount gateway-bound providers while
   preserving the router pathname.

Every REST request and socket captures its generation. A response or frame from
an older generation is discarded. Pairing an additional profile does not
activate it. Removing one profile revokes and deletes only that exact origin.
An unreachable last-active profile remains selected as an honest error state;
the application does not silently show another gateway's data.

Browser sessions use an instance-specific cookie name for every non-default
home. HTTP cookies are host-scoped rather than port-scoped, so another gateway
on the same host can receive an unknown cookie name at the protocol level; it
cannot select or authenticate with that credential. Each gateway accepts only
the names derived from its own home.

## Consequences

- Two loopback gateways on different ports never share usable authentication.
- Route continuity and data isolation are independent concerns: `/todos` can
  remain the route while its data, cache, identity, and socket all change.
- Durable gateway-owned browser storage must be namespaced or cleared when new
  persisted features are introduced.
- Adding another transport must preserve generation fencing rather than bypass
  the profile manager.
