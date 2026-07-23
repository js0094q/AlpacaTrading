import {
  getAlpacaPaperEndpoint,
  type AlpacaApiResponse,
  type AlpacaRequestContext
} from "./alpacaClient.js";

export interface AlpacaMarketClockSnapshot {
  timestamp?: string;
  isOpen?: boolean;
  nextOpen?: string;
  nextClose?: string;
  requestId?: string;
}

type ApiClockPayload = {
  timestamp?: string;
  is_open?: boolean;
  next_open?: string;
  next_close?: string;
};

export const getAlpacaMarketClock = async (
  context: AlpacaRequestContext = {}
): Promise<AlpacaMarketClockSnapshot> => {
  const response: AlpacaApiResponse<ApiClockPayload> =
    await getAlpacaPaperEndpoint<ApiClockPayload>("/v2/clock", context);
  return {
    timestamp: response.data.timestamp,
    isOpen: response.data.is_open,
    nextOpen: response.data.next_open,
    nextClose: response.data.next_close,
    requestId: response.requestId
  };
};
