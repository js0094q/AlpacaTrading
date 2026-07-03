import { guardedGet } from "../../_lib/routeHelpers";
import { runPaperDryRun } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () =>
  guardedGet(() => runPaperDryRun({
    riskProfile: "aggressive",
    optionsEnabled: true,
    maxCandidates: 10,
    assetClass: "all"
  }));
