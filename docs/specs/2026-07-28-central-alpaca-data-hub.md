# Central Alpaca Data Hub and Event Fan-Out

## Scope

Section 6 centralizes the existing Alpaca read paths without changing scoring,
execution, sizing, or PostgreSQL authority.

- One shared stock stream instance is registered per endpoint/feed.
- The research workflow hydrates one cycle-scoped hub view from the existing
  PostgreSQL-persisted market refresh.
- Equity, 0DTE, and LEAPS receive the same immutable quote object for a symbol
  and cycle.
- Stream disconnects and subscriber failures remain local to the data path.
- REST hydration is identified as startup, explicit refresh, or recovery and
  is deduplicated for the cycle.
- Reconciliation can fan out order lifecycle state without creating orders.
- Account activities are polled serially for assignment, exercise, expiration,
  fill, and other non-streamed broker events.

## Provenance contract

Every normalized hub event retains:

- `provider=alpaca`
- explicit feed or `null`
- symbol or `null`
- event type
- provider timestamp or an explicit `null` when the endpoint supplies none
- receipt timestamp
- `environment=paper`
- transport (`stream`, `rest`, or `reconciliation`)

Feed is part of cache identity. SIP, IEX, delayed, and OPRA observations are not
silently substituted for one another.

## Connection and recovery contract

The stream service authenticates before subscription, creates one socket for a
shared endpoint, and reconnects after unexpected closure. Delay is exponential
from `ALPACA_STOCK_STREAM_RECONNECT_MS` and is capped by
`ALPACA_STOCK_STREAM_RECONNECT_MAX_MS`. Status exposes reconnect attempts, the
last delay, and the next scheduled reconnect time without credentials.

Last-known data survives disconnect. A failed fan-out consumer is reported but
does not close the socket or terminate the service.

## Boundaries

This phase does not:

- implement option scoring;
- add a research adapter;
- create a broker mutation;
- change paper/live gates;
- change OPRA authority;
- change LEAPS or equity sizing;
- add SQLite runtime access;
- begin Section 7.
