import { guardedHistoricalPost } from "../../../_lib/routeHelpers";
import { runPaperPortfolioReview } from "../../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) =>
  guardedHistoricalPost(request, runPaperPortfolioReview, {
    vpsPath: "/api/v1/actions/portfolio/review",
    timeoutMs: 60_000,
    requireAdminToken: true
  });
