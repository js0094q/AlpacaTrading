import { guardedPost } from "../../_lib/routeHelpers";
import { runPaperConfirm } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedPost(request, runPaperConfirm, {
    requireOrderSubmission: true
  });
