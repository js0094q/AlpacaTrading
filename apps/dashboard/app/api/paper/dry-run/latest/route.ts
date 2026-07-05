import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { runPaperDryRun } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => runPaperDryRun({
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  }), {
    vpsPath: "/api/v1/execute/dry-run/latest",
    timeoutMs: 120_000
  });
