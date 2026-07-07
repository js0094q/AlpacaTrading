import { guardedPost } from "../../_lib/routeHelpers";
import { runPaperReviewedExecution } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedPost(request, runPaperReviewedExecution, {
    vpsPath: "/api/v1/actions/execute",
    timeoutMs: 120_000,
    requireAdminToken: true
  });
