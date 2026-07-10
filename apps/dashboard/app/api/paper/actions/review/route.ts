import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runPaperOpsReviewAction } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, () => runPaperOpsReviewAction(), {
    vpsPath: "/api/v1/actions/review",
    timeoutMs: 120_000,
    requireAdminToken: true
  });
