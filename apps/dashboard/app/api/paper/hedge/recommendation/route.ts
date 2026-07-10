import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestHedgeDashboardRecommendation } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestHedgeDashboardRecommendation(), {
    vpsPath: "/api/v1/hedge/recommendation",
    timeoutMs: 30_000
  });
