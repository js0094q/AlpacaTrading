import { guardedPost } from "../../_lib/routeHelpers";
import { runPaperOrderCancellation } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedPost(request, runPaperOrderCancellation, {
    requireOrderSubmission: true,
    vpsPath: "/api/v1/orders/cancel",
    timeoutMs: 120_000,
    requireAdminToken: true
  });
