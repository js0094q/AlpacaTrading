import { isVercelRuntime } from "../../../src/lib/runtime";

export const VERCEL_READ_ONLY_MODE = "vercel-read-only" as const;

export const VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE =
  "Historical runtime data unavailable on Vercel. Trading runtime and ledger live on VPS.";

export const VERCEL_HISTORICAL_STORAGE_WARNING =
  "Historical runtime data is stored on the VPS. Configure durable dashboard storage to show this data on Vercel.";

export const hasDashboardDurableStorageConfig = () =>
  Boolean(process.env.DASHBOARD_DATABASE_URL?.trim());

export const DASHBOARD_PAPER_BRIDGE_URL = process.env.PAPER_DASHBOARD_BRIDGE_URL?.trim();
export const DASHBOARD_PAPER_BRIDGE_TOKEN = process.env.PAPER_DASHBOARD_BRIDGE_TOKEN?.trim();

export const isPaperDashboardBridgeEnabled = () =>
  isVercelRuntime() && Boolean(DASHBOARD_PAPER_BRIDGE_URL);

export const shouldUseVercelReadOnlyFallback = () =>
  isVercelRuntime() && !isPaperDashboardBridgeEnabled();

export const buildVercelHistoricalFallback = <T>(data: T) => ({
  ok: true as const,
  mode: VERCEL_READ_ONLY_MODE,
  data,
  warning: VERCEL_HISTORICAL_STORAGE_WARNING
});

export {
  isVercelRuntime
};
