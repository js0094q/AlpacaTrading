import { getAlpacaPaperEndpoint, type AlpacaApiResponse } from "./alpacaClient.js";

export interface AlpacaPositionSnapshot {
  symbol: string;
  assetId?: string;
  assetClass?: string;
  qty?: string;
  qtyAvailable?: string;
  averageEntryPrice?: string;
  marketValue?: string;
  costBasis?: string;
  unrealizedPl?: string;
  unrealizedPlpc?: string;
  currentPrice?: string;
  side?: string;
}

type ApiPositionPayload = {
  symbol?: string;
  asset_id?: string;
  asset_class?: string;
  qty?: string;
  qty_available?: string;
  avg_entry_price?: string;
  market_value?: string;
  cost_basis?: string;
  unrealized_pl?: string;
  unrealized_plpc?: string;
  current_price?: string;
  side?: string;
};

const mapPosition = (row: ApiPositionPayload): AlpacaPositionSnapshot => ({
  symbol: String(row.symbol || ""),
  assetId: row.asset_id,
  assetClass: row.asset_class,
  qty: row.qty,
  qtyAvailable: row.qty_available,
  averageEntryPrice: row.avg_entry_price,
  marketValue: row.market_value,
  costBasis: row.cost_basis,
  unrealizedPl: row.unrealized_pl,
  unrealizedPlpc: row.unrealized_plpc,
  currentPrice: row.current_price,
  side: row.side
});

export const listAlpacaPositions = async (): Promise<{
  positions: AlpacaPositionSnapshot[];
  requestId?: string;
}> => {
  const response: AlpacaApiResponse<ApiPositionPayload[]> =
    await getAlpacaPaperEndpoint<ApiPositionPayload[]>("/v2/positions");
  if (!Array.isArray(response.data)) {
    throw new Error("BROKER_POSITION_RESPONSE_INVALID");
  }
  const payload = response.data;
  return {
    positions: payload.map(mapPosition),
    requestId: response.requestId
  };
};
