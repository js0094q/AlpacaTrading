export const RESEARCH_IMPORT_MAX_BYTES = 1_000_000;

export const readBoundedResearchImportJson = async (
  input: AsyncIterable<unknown>,
  maximumBytes = RESEARCH_IMPORT_MAX_BYTES
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk)
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk)
        : null;
    if (!bytes) throw new Error("RESEARCH_IMPORT_INPUT_INVALID");
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumBytes) {
      throw new Error("RESEARCH_IMPORT_INPUT_TOO_LARGE");
    }
    chunks.push(bytes);
  }
  const serialized = Buffer.concat(chunks).toString("utf8").trim();
  if (!serialized) throw new Error("RESEARCH_IMPORT_INPUT_REQUIRED");
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("RESEARCH_IMPORT_JSON_INVALID");
  }
};
