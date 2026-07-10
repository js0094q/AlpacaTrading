import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestHedgeDashboardRisk } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestHedgeDashboardRisk(), {
    vpsPath: "/api/v1/hedge/risk",
    timeoutMs: 30_000
  });
