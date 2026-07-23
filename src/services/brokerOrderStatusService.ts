const TERMINAL_BROKER_ORDER_STATUSES = new Set([
  "canceled",
  "cancelled",
  "expired",
  "filled",
  "rejected",
  "replaced"
]);

const KNOWN_ACTIVE_BROKER_ORDER_STATUSES = new Set([
  "accepted",
  "accepted_for_bidding",
  "calculated",
  "done_for_day",
  "held",
  "new",
  "partially_filled",
  "pending_cancel",
  "pending_new",
  "pending_replace",
  "stopped",
  "submitted",
  "suspended"
]);

export interface BrokerOrderStatusClassification {
  normalized: string;
  active: boolean;
  terminal: boolean;
  known: boolean;
}

export const classifyBrokerOrderStatus = (
  value: unknown
): BrokerOrderStatusClassification => {
  const normalized = String(value ?? "").trim().toLowerCase();
  const terminal = TERMINAL_BROKER_ORDER_STATUSES.has(normalized);
  const known = terminal || KNOWN_ACTIVE_BROKER_ORDER_STATUSES.has(normalized);
  return {
    normalized,
    terminal,
    known,
    // Unknown non-empty statuses from an open-order source remain capacity-consuming.
    active: Boolean(normalized) && !terminal
  };
};

export const isActiveBrokerOrderStatus = (value: unknown) =>
  classifyBrokerOrderStatus(value).active;
