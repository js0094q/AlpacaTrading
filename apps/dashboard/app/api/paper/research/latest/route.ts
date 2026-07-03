import { guardedGet } from "../../_lib/routeHelpers";
import { latestResearchRuns } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => guardedGet(() => latestResearchRuns(10));
