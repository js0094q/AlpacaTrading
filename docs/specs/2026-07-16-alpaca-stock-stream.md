# Alpaca SIP Stock Stream

## Goal

Add one paper-only, in-memory Alpaca SIP stock WebSocket service for the active
application universe without changing existing SIP REST market-data calls or any
order-routing behavior.

## Verified current state

- Stock REST market data already defaults to SIP in `src/config.ts` and the
  existing Alpaca clients.
- No stock WebSocket client or WebSocket dependency is present.
- `server/dashboard-control/server.ts` is the repository's long-running server
  startup boundary; before this change it had no stock-stream lifecycle integration.
- The active symbol universe is read from `getActiveUniverse()`; the seeded
  universe is the configuration fallback.
- The repository remains paper-only and live trading stays disabled.

## Scope

- Add `src/services/alpacaStockStream.ts` with injected WebSocket and logging
  dependencies for deterministic tests.
- Add validated, disabled-by-default stream settings to `src/config.ts`.
- Start exactly one stream service from the dashboard-control process when
  explicitly enabled, and stop it on SIGINT/SIGTERM.
- Keep latest normalized trades, quotes, and minute bars in memory only.
- Add a sanitized read-only smoke script and focused mocked-WebSocket tests.
- Update `.env.example` and relevant documentation with non-secret settings.

## Non-goals

- No database schema, queue, broker, cache, event sourcing, or new streaming
  architecture.
- No IEX fallback, live trading, order submission, strategy recalibration, or
  replacement of the existing REST path.
- No direct edits to the user's local `.env`.

## Contracts

- Stream URL is the configured SIP URL and status feed is always `sip`.
- Authentication must succeed before subscription is sent.
- Reconnect uses one fixed delay, one active socket, and no reconnect after
  intentional stop.
- Symbol updates use subscribe/unsubscribe messages without reconnecting.
- Status and logs never contain credentials or raw authentication payloads.

## Validation

- Focused mocked-WebSocket tests cover configuration, protocol ordering,
  normalization, state, staleness, reconnect, shutdown, dynamic symbols, logs,
  and disabled mode.
- Run the full test suite, typecheck, lint, build, and the sanitized SIP smoke
  script. The smoke script must perform only a WebSocket auth/subscribe/read
  interaction and must not submit orders.
