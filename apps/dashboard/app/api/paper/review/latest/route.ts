import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { runPaperReview } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () =>
  guardedHistoricalGet(() => runPaperReview({
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  }));
