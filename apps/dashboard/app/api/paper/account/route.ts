import { getAlpacaAccountSnapshot } from "../../../../../../src/services/alpacaAccountService";
import { guardedGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) =>
  guardedGet(request, () => getAlpacaAccountSnapshot(), {
    vpsPath: "/api/v1/account",
    timeoutMs: 30_000
  });
