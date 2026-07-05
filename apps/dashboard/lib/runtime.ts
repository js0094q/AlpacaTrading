import { isVercelRuntime } from "../../../src/lib/runtime";

export const VERCEL_READ_ONLY_MODE = "vercel-read-only" as const;

export const VERCEL_HISTORICAL_UNAVAILABLE_MESSAGE =
  "Historical runtime data unavailable on Vercel. Trading runtime and ledger live on VPS.";

export const VERCEL_HISTORICAL_STORAGE_WARNING =
  "Historical runtime data is stored on the VPS. Configure durable dashboard storage to show this data on Vercel.";

export const hasDashboardDurableStorageConfig = () =>
  Boolean(process.env.DASHBOARD_DATABASE_URL?.trim());

const readEnvValue = (name: string) => process.env[name]?.trim();

export const DASHBOARD_PAPER_BRIDGE_URL = () => readEnvValue("PAPER_DASHBOARD_BRIDGE_URL");
export const DASHBOARD_PAPER_BRIDGE_TOKEN = () => readEnvValue("PAPER_DASHBOARD_BRIDGE_TOKEN");

export const resolveVpsControlBaseUrl = () =>
  readEnvValue("VPS_CONTROL_BASE_URL") || DASHBOARD_PAPER_BRIDGE_URL();
export const resolveDashboardControlToken = () =>
  readEnvValue("VPS_CONTROL_TOKEN") || DASHBOARD_PAPER_BRIDGE_TOKEN();
export const resolveDashboardAdminToken = () => readEnvValue("DASHBOARD_ADMIN_TOKEN");

export const DASHBOARD_CONTROL_BASE_URL = () => resolveVpsControlBaseUrl();
export const DASHBOARD_CONTROL_TOKEN = () => resolveDashboardControlToken();
export const DASHBOARD_ADMIN_TOKEN = () => resolveDashboardAdminToken();

export const isPaperDashboardBridgeEnabled = () =>
  isVercelRuntime() && Boolean(DASHBOARD_CONTROL_BASE_URL());

export const isPaperDashboardAdminEnabled = () =>
  isVercelRuntime() && Boolean(DASHBOARD_ADMIN_TOKEN());

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
