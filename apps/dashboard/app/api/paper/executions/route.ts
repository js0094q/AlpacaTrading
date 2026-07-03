import { listPaperExecutionLedgerEntries } from "../../../../../../src/services/paperExecutionLedgerService";
import { guardedGet } from "../_lib/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = () => guardedGet(() => listPaperExecutionLedgerEntries(100));
