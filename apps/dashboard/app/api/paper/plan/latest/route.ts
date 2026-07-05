import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestPaperPlans } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestPaperPlans(25), {
    vpsPath: "/api/v1/plan/latest",
    timeoutMs: 30_000
  });
