import { guardedGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedGet(request, async () => ({}), {
    vpsPath: "/api/v1/health",
    timeoutMs: 10_000
  });
