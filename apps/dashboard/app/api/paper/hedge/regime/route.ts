import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestHedgeDashboardRegime } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestHedgeDashboardRegime(), {
    vpsPath: "/api/v1/hedge/regime",
    timeoutMs: 30_000
  });
