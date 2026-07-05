import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runPaperDryRun } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runPaperDryRun, {
    vpsPath: "/api/v1/execute/dry-run",
    timeoutMs: 120_000,
    requireAdminToken: true
  });
