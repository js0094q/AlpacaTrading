import { getAlpacaPaperEndpoint, type AlpacaApiResponse } from "./alpacaClient.js";

export interface AlpacaOpenOrderSnapshot {
  id: string;
  clientOrderId?: string;
  symbol: string;
  assetClass?: string;
  qty?: string;
  notional?: string;
  side?: string;
  type?: string;
  timeInForce?: string;
  status?: string;
  submittedAt?: string;
  filledQty?: string;
  filledAvgPrice?: string;
}

type ApiOrderPayload = {
  id?: string;
  client_order_id?: string;
  symbol?: string;
  asset_class?: string;
  qty?: string;
  notional?: string;
  side?: string;
  type?: string;
  time_in_force?: string;
  status?: string;
  submitted_at?: string;
  filled_qty?: string;
  filled_avg_price?: string;
};

const mapOrder = (row: ApiOrderPayload): AlpacaOpenOrderSnapshot => ({
  id: String(row.id || ""),
  clientOrderId: row.client_order_id,
  symbol: String(row.symbol || ""),
  assetClass: row.asset_class,
  qty: row.qty,
  notional: row.notional,
  side: row.side,
  type: row.type,
  timeInForce: row.time_in_force,
  status: row.status,
  submittedAt: row.submitted_at,
  filledQty: row.filled_qty,
  filledAvgPrice: row.filled_avg_price
});

export const listAlpacaOpenOrders = async (): Promise<{
  orders: AlpacaOpenOrderSnapshot[];
  requestId?: string;
}> => {
  const response: AlpacaApiResponse<ApiOrderPayload[]> =
    await getAlpacaPaperEndpoint<ApiOrderPayload[]>("/v2/orders?status=open");
  const payload = Array.isArray(response.data) ? response.data : [];
  return {
    orders: payload.map(mapOrder),
    requestId: response.requestId
  };
};
