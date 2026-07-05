import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runPaperReview } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runPaperReview, {
    vpsPath: "/api/v1/review/run",
    timeoutMs: 60_000,
    requireAdminToken: true
  });
