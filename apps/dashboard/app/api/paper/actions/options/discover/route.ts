import { guardedHistoricalPost } from "../../../_lib/routeHelpers";
import { runPaperOptionsDiscovery } from "../../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runPaperOptionsDiscovery, {
    vpsPath: "/api/v1/actions/options/discover",
    timeoutMs: 60_000,
    requireAdminToken: true
  });
