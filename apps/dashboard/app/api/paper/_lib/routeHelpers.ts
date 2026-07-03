import {
  assertPaperDashboardAccess,
  assertPaperOptionsSubmissionEnabled,
  assertPaperOrderSubmissionEnabled,
  noStoreJson,
  sanitizeDashboardError
} from "../../../../lib/guards";
import { parsePaperActionInput, type PaperActionInput } from "../../../../lib/data";

export const guardedGet = async (handler: () => Promise<unknown> | unknown) => {
  try {
    assertPaperDashboardAccess();
    return noStoreJson({ ok: true, data: await handler() });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};

const readActionInput = async (request: Request): Promise<PaperActionInput> => {
  try {
    return parsePaperActionInput(await request.json());
  } catch {
    return parsePaperActionInput({});
  }
};

export const guardedPost = async (
  request: Request,
  handler: (input: PaperActionInput) => Promise<unknown> | unknown,
  options: {
    requireOrderSubmission?: boolean;
    requireOptionsSubmission?: boolean;
  } = {}
) => {
  try {
    assertPaperDashboardAccess();
    const input = await readActionInput(request);
    if (options.requireOrderSubmission) {
      assertPaperOrderSubmissionEnabled();
    }
    if (
      options.requireOptionsSubmission ||
      (options.requireOrderSubmission && input.assetClass !== "equity")
    ) {
      assertPaperOptionsSubmissionEnabled();
    }
    return noStoreJson({ ok: true, data: await handler(input) });
  } catch (error) {
    const sanitized = sanitizeDashboardError(error);
    return noStoreJson(sanitized.body, { status: sanitized.status });
  }
};
