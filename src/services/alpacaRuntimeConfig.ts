import { config as loadDotenv } from "dotenv";

loadDotenv();
loadDotenv({ path: ".env.txt", override: false });

export const alpacaRuntimeConfig = {
  paperBaseUrl:
    process.env.ALPACA_PAPER_BASE_URL?.trim() ||
    "https://paper-api.alpaca.markets",
  dataBaseUrl:
    process.env.ALPACA_DATA_BASE_URL?.trim() ||
    "https://data.alpaca.markets",
  liveBaseUrl:
    process.env.ALPACA_LIVE_BASE_URL?.trim() ||
    "https://api.alpaca.markets",
  stockDataFeed: process.env.ALPACA_STOCK_DATA_FEED?.trim() || "sip",
  optionDataFeed: process.env.ALPACA_OPTION_DATA_FEED?.trim() || "opra",
  userAgent: process.env.ALPACA_USER_AGENT?.trim() || "alpaca-research-cli"
};
