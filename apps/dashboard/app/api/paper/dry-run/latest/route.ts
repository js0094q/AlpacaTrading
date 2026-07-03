import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { runPaperDryRun } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () =>
  guardedHistoricalGet(() => runPaperDryRun({
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  }));
