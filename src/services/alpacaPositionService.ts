import { getAlpacaPaperEndpoint, type AlpacaApiResponse } from "./alpacaClient.js";

export interface AlpacaPositionSnapshot {
  symbol: string;
  assetId?: string;
  assetClass?: string;
  qty?: string;
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
  const payload = Array.isArray(response.data) ? response.data : [];
  return {
    positions: payload.map(mapPosition),
    requestId: response.requestId
  };
};
