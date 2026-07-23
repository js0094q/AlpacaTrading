import { guardedGet } from "../../_lib/routeHelpers";
import { latestZeroDteSummary } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedGet(request, () => latestZeroDteSummary(25), {
    vpsPath: "/api/v1/zero-dte/summary",
    timeoutMs: 30_000
  });
