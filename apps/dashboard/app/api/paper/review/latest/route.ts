import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { runPaperReview } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => runPaperReview({
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  }), {
    vpsPath: "/api/v1/review/latest",
    timeoutMs: 60_000
  });
