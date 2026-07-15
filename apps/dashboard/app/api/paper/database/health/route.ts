import {
  assertDashboardAdminToken,
  assertPaperDashboardAccess,
  noStoreJson,
  sanitizeDashboardError
} from "../../../../../lib/guards";
import { buildVercelPostgresDatabaseHealth } from "../../../../../lib/databaseHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
};

export const GET = async (request: Request) => {
  try {
    assertPaperDashboardAccess();
    assertDashboardAdminToken(bearerToken(request));
    return noStoreJson({
      ok: true,
      database: await buildVercelPostgresDatabaseHealth()
    });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};
