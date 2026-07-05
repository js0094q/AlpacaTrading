import { guardedPost } from "../_lib/routeHelpers";
import { buildDashboardSnapshot } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedPost(request, () => buildDashboardSnapshot(), {
    requireAdminToken: true,
    vpsPath: "/api/v1/refresh",
    timeoutMs: 60_000
  });
