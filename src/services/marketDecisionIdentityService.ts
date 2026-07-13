import { randomUUID } from "node:crypto";
import type { DecisionId, PositionLifecycleId } from "../types.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isDecisionId = (value: unknown): value is DecisionId =>
  typeof value === "string" && UUID_V4.test(value);

export const isPositionLifecycleId = (
  value: unknown
): value is PositionLifecycleId =>
  typeof value === "string" && UUID_V4.test(value);

export const createDecisionId = (): DecisionId => randomUUID() as DecisionId;

export const createPositionLifecycleId = (): PositionLifecycleId =>
  randomUUID() as PositionLifecycleId;

export const asDecisionId = (value: string): DecisionId => {
  if (!isDecisionId(value)) {
    throw new Error("DECISION_ID_INVALID");
  }
  return value;
};

export const asPositionLifecycleId = (value: string): PositionLifecycleId => {
  if (!isPositionLifecycleId(value)) {
    throw new Error("POSITION_LIFECYCLE_ID_INVALID");
  }
  return value;
};
