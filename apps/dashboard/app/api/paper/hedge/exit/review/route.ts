import { guardedHistoricalPost } from "../../../_lib/routeHelpers";
import { runHedgeExitReviewAction } from "../../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runHedgeExitReviewAction, {
    vpsPath: "/api/v1/hedge/exit/review",
    timeoutMs: 60_000,
    requireAdminToken: true,
    requireHedgeDashboardMutations: true
  });
