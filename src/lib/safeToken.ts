import { createHash, timingSafeEqual } from "node:crypto";

export const safeTokenEquals = (
  provided: string | null | undefined,
  expected: string | null | undefined
): boolean => {
  if (!provided || !expected) {
    return false;
  }

  if (!provided.trim() || !expected.trim()) {
    return false;
  }

  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(providedDigest, expectedDigest);
};
