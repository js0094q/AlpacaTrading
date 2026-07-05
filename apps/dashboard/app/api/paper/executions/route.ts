import { guardedHistoricalGet } from "../_lib/routeHelpers";
import { latestPaperExecutions } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestPaperExecutions(100), {
    vpsPath: "/api/v1/executions",
    timeoutMs: 30_000
  });
