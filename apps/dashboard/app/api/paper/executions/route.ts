import { listPaperExecutionLedgerEntries } from "../../../../../../src/services/paperExecutionLedgerService";
import { guardedHistoricalGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () =>
  guardedHistoricalGet(() => listPaperExecutionLedgerEntries(100));
