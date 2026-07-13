import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestHedgeLearningStatus } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestHedgeLearningStatus(), {
    vpsPath: "/api/v1/hedge/learning",
    timeoutMs: 30_000
  });
