import { guardedHistoricalPost } from "../../_lib/routeHelpers";
import { runPaperResearch } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runPaperResearch, {
    vpsPath: "/api/v1/research/run",
    timeoutMs: 420_000,
    requireAdminToken: true
  });
