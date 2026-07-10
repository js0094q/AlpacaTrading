import { createHash } from "node:crypto";

export const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)])
  );
};

export const canonicalJsonHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex");
