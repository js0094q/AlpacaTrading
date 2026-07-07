import { guardedHistoricalPost } from "../../../_lib/routeHelpers";
import { runPaperLearningCommit } from "../../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, () => runPaperLearningCommit(), {
    vpsPath: "/api/v1/actions/learn/run",
    timeoutMs: 120_000,
    requireAdminToken: true
  });
