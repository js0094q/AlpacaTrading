import { listAlpacaPositions } from "../../../../../../src/services/alpacaPositionService";
import { guardedGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => guardedGet(() => listAlpacaPositions());
