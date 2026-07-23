import { canonicalJsonHash } from "../../lib/canonicalJson.js";
import type {
  ZeroDteDirection,
  ZeroDtePlaybook
} from "./zeroDteTypes.js";

export interface ZeroDteCandidateIdentityInput {
  tradingDate: string;
  underlying: string;
  optionSymbol: string;
  playbook: ZeroDtePlaybook;
  direction: ZeroDteDirection;
  expirationDate: string;
  strike: number;
}

export interface ZeroDteClientOrderIdentityInput {
  tradingDate: string;
  candidateId: string;
  action: "entry" | "exit";
  attempt: number;
}

const normalizeSymbol = (value: string) => value.trim().toUpperCase();
const normalizeDate = (value: string) => value.trim();

const normalizeStrikeText = (value: number) => {
  if (!Number.isFinite(value)) {
    throw new RangeError("0DTE strike must be finite");
  }
  return String(Number(value));
};

const normalizedCandidateIdentity = (input: ZeroDteCandidateIdentityInput) => ({
  tradingDate: normalizeDate(input.tradingDate),
  underlying: normalizeSymbol(input.underlying),
  optionSymbol: normalizeSymbol(input.optionSymbol),
  playbook: input.playbook,
  direction: input.direction,
  expirationDate: normalizeDate(input.expirationDate),
  strike: normalizeStrikeText(input.strike)
});

export const buildZeroDteCandidateId = (
  input: ZeroDteCandidateIdentityInput
): string => `zdt_${canonicalJsonHash(normalizedCandidateIdentity(input))}`;

export const buildZeroDteDecisionId = (runId: string, candidateId: string): string =>
  `zdec_${canonicalJsonHash({
    runId: runId.trim(),
    candidateId: candidateId.trim()
  })}`;

export const buildZeroDteClientOrderId = (
  input: ZeroDteClientOrderIdentityInput
): string => {
  if (!Number.isInteger(input.attempt) || input.attempt < 0) {
    throw new RangeError("0DTE order attempt must be a non-negative integer");
  }

  const digest = canonicalJsonHash({
    tradingDate: normalizeDate(input.tradingDate),
    candidateId: input.candidateId.trim(),
    action: input.action,
    attempt: input.attempt
  });

  // Alpaca client order IDs have a 48-character limit. Hex keeps the ID
  // within the broker-safe character set while retaining 160 bits of entropy.
  return `zord_${digest.slice(0, 40)}`;
};
