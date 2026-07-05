import { listAlpacaOpenOrders } from "../../../../../../src/services/alpacaOrderReadService";
import { guardedGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedGet(request, () => listAlpacaOpenOrders(), {
    vpsPath: "/api/v1/orders",
    timeoutMs: 30_000
  });
