# Fresh Alpaca SIP Stream State Before REST

## Goal

Use fresh in-memory Alpaca SIP stock stream quote/trade state for eligible
current market-data reads while preserving the existing SIP REST path as the
safe fallback.

## Verified current state

- `src/services/alpacaStockStream.ts` provides one reusable SIP stream service
  with status, latest trade/quote/bar getters, symbol coverage, and staleness
  checks.
- `src/services/alpacaClient.ts` already centralizes stock snapshot requests
  on the configured SIP feed.
- The paper-exit review is the existing current equity-price consumer that can
  use a latest trade or quote without reconstructing a complete snapshot.
- Historical bars, research backfills, and complete snapshot reads have their
  own REST contracts and are not stream substitutions.

## Scope

- Add one shared `src/services/stockMarketDataAccessor.ts` selection layer.
- Prefer a covered, valid, fresh SIP stream trade or quote when the stream is
  enabled, connected, authenticated, and subscribed.
- Fall back to the existing SIP stock snapshot request for unavailable,
  malformed, or stale stream state.
- Use the accessor for the paper-exit review's current equity price read.
- Expose SIP source and timestamp provenance on the internal accessor result.
- Include the stream health object in the dashboard-control health response.

## Non-goals and safety boundaries

- Do not change strategy thresholds, order routing, order payloads, or live
  trading configuration.
- Do not remove or bypass SIP REST requests.
- Do not use stream bars to fabricate quote/trade/snapshot fields.
- Do not change historical bars, research backfills, or complete snapshot
  consumers.
- Do not add persistence, queues, caches, migrations, or another WebSocket.
- Do not add an IEX fallback or edit the user's local `.env`.

## Selection contract

For a requested symbol, stream state is eligible only when its status is
enabled, connected, authenticated, subscribed, and SIP-backed; the symbol is
covered; the event symbol matches; the event fields are valid; and
`isStale(event.timestamp)` is false. Any failed check calls the existing SIP
REST accessor. A stream lookup or freshness error is contained so it cannot
prevent the REST fallback.

Current prices use a fresh trade first, then a fresh non-crossed quote
midpoint. Bars are not used for stream-first current reads. The REST fallback
retains the existing latest-trade, quote-midpoint, minute-bar, daily-bar, and
previous-daily-bar precedence.

## Validation

- Focused accessor tests cover stream preference, readiness gates, symbol
  coverage, stale/malformed state, lookup failure, SIP fallback, and no bar
  fabrication.
- Paper-exit tests cover consumption of a fresh stream current price.
- Run the focused stream/accessor tests, full test suite, typecheck, lint,
  build, diff check, and the read-only stream smoke script.
- Runtime activation is an explicit environment operation: set the documented
  non-secret stream variables on the applicable VPS/local runtime, restart
  `alpaca-dashboard-control`, and verify the sanitized health fields. The
  repository `.env` remains untouched.
