import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runHedgeReviewAction } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, () => runHedgeReviewAction(), {
    vpsPath: "/api/v1/hedge/review",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireHedgeDashboardMutations: true
  });
