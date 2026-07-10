import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { listPaperOperations } from "../../../../../../../src/services/paperOperationLogService";
import { latestReviewArtifactReadiness } from "../../../../../../../src/services/paperOpsWorkflowService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedHistoricalGet(request, () => ({
    operations: listPaperOperations(25),
    reviewReadiness: latestReviewArtifactReadiness()
  }), {
    vpsPath: "/api/v1/actions/history",
    timeoutMs: 30_000
  });
