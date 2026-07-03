import { guardedHistoricalGet } from "../_lib/routeHelpers";
import { latestPaperExecutions } from "../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () =>
  guardedHistoricalGet(() => latestPaperExecutions(100));
