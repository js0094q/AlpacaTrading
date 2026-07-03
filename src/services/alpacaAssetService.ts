import {
  AlpacaApiError,
  getAlpacaPaperEndpoint,
  type AlpacaApiResponse
} from "./alpacaClient.js";
import { normalizeSymbol } from "../lib/utils.js";

export interface AlpacaAssetSnapshot {
  id?: string;
  class?: string;
  exchange?: string;
  symbol: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easyToBorrow?: boolean;
  fractionable?: boolean;
  maintenanceMarginRequirement?: number;
  attributes?: string[];
  requestId?: string;
}

export type AlpacaAssetFilterReason =
  | "asset_not_found"
  | "inactive"
  | "not_tradable"
  | "api_error";

export interface AlpacaAssetTradabilityResult {
  symbol: string;
  tradable: boolean;
  reason?: AlpacaAssetFilterReason;
  asset?: AlpacaAssetSnapshot;
  requestId?: string;
}

type ApiAssetPayload = {
  id?: string;
  class?: string;
  exchange?: string;
  symbol?: string;
  name?: string;
  status?: string;
  tradable?: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easy_to_borrow?: boolean;
  fractionable?: boolean;
  maintenance_margin_requirement?: number;
  attributes?: string[];
};

const mapAsset = (row: ApiAssetPayload): AlpacaAssetSnapshot => ({
  id: row.id,
  class: row.class,
  exchange: row.exchange,
  symbol: row.symbol || "",
  name: row.name,
  status: row.status,
  tradable: row.tradable,
  marginable: row.marginable,
  shortable: row.shortable,
  easyToBorrow: row.easy_to_borrow,
  fractionable: row.fractionable,
  maintenanceMarginRequirement: row.maintenance_margin_requirement,
  attributes: row.attributes
});

const buildNotFoundResult = (symbol: string): AlpacaAssetTradabilityResult => ({
  symbol,
  tradable: false,
  reason: "asset_not_found"
});

const buildInactiveResult = (asset: AlpacaAssetSnapshot, requestId?: string): AlpacaAssetTradabilityResult => ({
  symbol: asset.symbol,
  tradable: false,
  reason: "inactive",
  asset,
  requestId
});

const buildUntradableResult = (asset: AlpacaAssetSnapshot, requestId?: string): AlpacaAssetTradabilityResult => ({
  symbol: asset.symbol,
  tradable: false,
  reason: "not_tradable",
  asset,
  requestId
});

export const getAlpacaAsset = async (symbol: string): Promise<AlpacaAssetSnapshot> => {
  const normalizedSymbol = normalizeSymbol(symbol);
  const response: AlpacaApiResponse<ApiAssetPayload> =
    await getAlpacaPaperEndpoint<ApiAssetPayload>(`/v2/assets/${encodeURIComponent(normalizedSymbol)}`);
  const asset = mapAsset({
    ...(response.data as ApiAssetPayload),
    symbol: normalizedSymbol
  });
  if (response.requestId) {
    asset.requestId = response.requestId;
  }
  return asset;
};

export const checkAlpacaSymbolTradability = async (
  symbol: string
): Promise<AlpacaAssetTradabilityResult> => {
  const normalizedSymbol = normalizeSymbol(symbol);

  if (!normalizedSymbol) {
    return { symbol: "", tradable: false, reason: "asset_not_found" };
  }

  try {
    const asset = await getAlpacaAsset(normalizedSymbol);
    if (asset.status !== "active") {
      return buildInactiveResult(asset, asset.requestId);
    }
    if (asset.tradable !== true) {
      return buildUntradableResult(asset, asset.requestId);
    }
    return { symbol: normalizedSymbol, tradable: true, asset, requestId: asset.requestId };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Missing Alpaca paper credentials.")) {
      throw error;
    }

    if (error instanceof AlpacaApiError && error.status === 404) {
      return buildNotFoundResult(normalizedSymbol);
    }
    return {
      symbol: normalizedSymbol,
      tradable: false,
      reason: "api_error",
      requestId: error instanceof AlpacaApiError ? error.requestId : undefined
    };
  }
};
