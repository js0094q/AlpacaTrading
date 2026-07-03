import { guardedHistoricalGet } from "../../_lib/routeHelpers";
import { latestPaperPlans } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => guardedHistoricalGet(() => latestPaperPlans(25));
