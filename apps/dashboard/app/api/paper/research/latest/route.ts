import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestResearchRuns } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => latestResearchRuns(10), {
    vpsPath: "/api/v1/research/latest",
    timeoutMs: 30_000
  });
