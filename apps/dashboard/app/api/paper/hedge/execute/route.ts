import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runHedgeExecutionAction } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runHedgeExecutionAction, {
    vpsPath: "/api/v1/hedge/execute",
    timeoutMs: 120_000,
    requireAdminToken: true,
    requireHedgeDashboardMutations: true,
    requireOrderSubmission: true,
    requireOptionsSubmission: true
  });
