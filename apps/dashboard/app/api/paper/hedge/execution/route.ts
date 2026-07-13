import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestHedgeExecutionStatus } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestHedgeExecutionStatus(), {
    vpsPath: "/api/v1/hedge/execution",
    timeoutMs: 30_000
  });
