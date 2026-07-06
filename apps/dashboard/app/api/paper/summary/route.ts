import { guardedGet } from "../_lib/routeHelpers";
import { buildDashboardSnapshot } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedGet(request, () => buildDashboardSnapshot(), {
    vpsPath: "/api/v1/summary",
    timeoutMs: 30_000
  });
