import { guardedHistoricalPost } from "../../../_lib/routeHelpers";
import { runHedgeExitExecutionAction } from "../../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runHedgeExitExecutionAction, {
    vpsPath: "/api/v1/hedge/exit/execute",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireHedgeDashboardMutations: true,
    requireOrderSubmission: true,
    requireOptionsSubmission: true
  });
