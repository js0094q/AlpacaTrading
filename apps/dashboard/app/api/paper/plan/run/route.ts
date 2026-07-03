import { guardedPost } from "../../_lib/routeHelpers";
import { runPaperPlan } from "../../../../../lib/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => guardedPost(request, runPaperPlan);
