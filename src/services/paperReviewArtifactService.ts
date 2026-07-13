import { randomUUID } from "node:crypto";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { getDb, queryAll, queryOne } from "../lib/db.js";
import type { DecisionId, DecisionRole, PositionLifecycleId } from "../types.js";
import {
  appendDecisionLifecycleEvent,
  linkPaperReviewDecision,
  persistDecisionSnapshot
} from "./marketDecisionEvidenceService.js";

export type ReviewedPayloadSectionName =
  | "equityBuys"
  | "equityAdds"
  | "equitySells"
  | "optionBuys"
  | "optionSellToCloseExits";

export const REVIEWED_PAYLOAD_SECTION_NAMES: ReviewedPayloadSectionName[] = [
  "equityBuys",
  "equityAdds",
  "equitySells",
  "optionBuys",
  "optionSellToCloseExits"
];

export const isReviewedPayloadSectionName = (
  value: string
): value is ReviewedPayloadSectionName =>
  REVIEWED_PAYLOAD_SECTION_NAMES.includes(value as ReviewedPayloadSectionName);

export type ReviewedPayloadSections = Record<ReviewedPayloadSectionName, unknown[]>;

export interface PaperReviewArtifact {
  id: string;
  createdAt: string;
  expiresAt: string;
  sourceAction: string;
  status: string;
  payloadSignature: string;
  payloadCount: number;
  artifact: {
    id: string;
    createdAt: string;
    expiresAt: string;
    sourceAction: string;
    status: string;
    payloadSignature: string;
    payloadSections: ReviewedPayloadSections;
    summary: Record<string, unknown>;
    warnings: string[];
    blockers: string[];
    details?: Record<string, unknown>;
  };
}

interface PaperReviewArtifactRow {
  id: string;
  created_at: string;
  expires_at: string;
  source_action: string;
  status: string;
  payload_signature: string;
  payload_count: number;
  artifact_json: string;
}

const emptySections = (): ReviewedPayloadSections => ({
  equityBuys: [],
  equityAdds: [],
  equitySells: [],
  optionBuys: [],
  optionSellToCloseExits: []
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const reasonCodesFromPayload = (payload: Record<string, unknown>) => {
  const reasons = Array.isArray(payload.reasonCodes)
    ? payload.reasonCodes
    : Array.isArray(payload.reasons)
      ? payload.reasons
      : [];
  const codes = reasons.filter(
    (reason): reason is string => typeof reason === "string" && Boolean(reason.trim())
  );
  const reason = stringValue(payload.reason);
  return codes.length ? codes : reason ? [reason] : ["REVIEW_ARTIFACT_PERSISTED"];
};

const decisionRoleForSection = (section: ReviewedPayloadSectionName): DecisionRole =>
  section === "equitySells" || section === "optionSellToCloseExits"
    ? "exit"
    : "entry";

const persistArtifactDecisionLinks = (input: {
  artifactId: string;
  createdAt: string;
  sourceAction: string;
  payloadSections: ReviewedPayloadSections;
}) => {
  for (const section of REVIEWED_PAYLOAD_SECTION_NAMES) {
    input.payloadSections[section].forEach((rawPayload, payloadIndex) => {
      const payload = isRecord(rawPayload) ? rawPayload : {};
      const role = decisionRoleForSection(section);
      const candidateId =
        stringValue(payload.sourceCandidateId) ?? stringValue(payload.candidateId);
      const candidateDecision =
        role === "entry" && candidateId
          ? queryOne<{ decision_id: DecisionId | null }>(
              "SELECT decision_id FROM paper_trade_candidates WHERE id = ? LIMIT 1",
              [candidateId]
            )
          : null;
      const existingSnapshot = candidateDecision?.decision_id
        ? queryOne<{ decision_id: DecisionId }>(
            "SELECT decision_id FROM decision_snapshots WHERE decision_id = ? LIMIT 1",
            [candidateDecision.decision_id]
          )
        : null;
      const symbol = stringValue(payload.symbol);
      const rawAssetClass =
        stringValue(payload.assetClass) ?? stringValue(payload.asset_class);
      const optionSymbol = rawAssetClass === "option" ? symbol : null;
      const providedPositionLifecycleId =
        stringValue(payload.positionLifecycleId) ??
        stringValue(payload.position_lifecycle_id);
      const exactExitPositions =
        role === "exit" && !providedPositionLifecycleId && symbol
          ? queryAll<{ position_lifecycle_id: PositionLifecycleId }>(
              `
              SELECT position_lifecycle_id
              FROM paper_positions
              WHERE status = 'OPEN'
                AND UPPER(COALESCE(option_symbol, symbol)) = UPPER(?)
              ORDER BY opened_at, position_lifecycle_id
              `,
              [symbol]
            )
          : [];
      const positionLifecycleId =
        providedPositionLifecycleId ??
        (exactExitPositions.length === 1
          ? exactExitPositions[0].position_lifecycle_id
          : null);
      const requestId =
        stringValue(payload.requestId) ?? stringValue(payload.request_id);
      const sourceTimestamp =
        stringValue(payload.sourceTimestamp) ?? stringValue(payload.source_timestamp);
      const feed = stringValue(payload.feed);
      const originId = `${input.artifactId}:${section}:${payloadIndex}`;
      const newSnapshot = existingSnapshot
        ? null
        : persistDecisionSnapshot({
          originType: "paper_review_artifact",
          originId,
          decisionRole: role,
          candidateId,
          positionLifecycleId: positionLifecycleId as PositionLifecycleId | null,
          createdAt: input.createdAt,
          strategyFamily:
            stringValue(payload.strategy) ?? stringValue(payload.strategyFamily),
          symbol: optionSymbol
            ? stringValue(payload.underlyingSymbol) ??
              stringValue(payload.underlying_symbol)
            : symbol,
          underlyingSymbol: optionSymbol
            ? stringValue(payload.underlyingSymbol) ??
              stringValue(payload.underlying_symbol)
            : null,
          optionSymbol,
          decisionStatus: "REVIEWED",
          reasonCodes: reasonCodesFromPayload(payload),
          rationale:
            payload.rationale ?? payload.explanation ?? payload.notes ?? payload.reason,
          signalInputs: payload,
          marketState: payload.marketState,
          instrumentState: payload.instrumentState,
          portfolioState: payload.portfolioState,
          riskState: payload.riskState,
          dataQualityStatus:
            stringValue(payload.dataQualityStatus) ?? "UNOBSERVED",
          sourceTimestamps: {
            artifactCreatedAt: input.createdAt,
            sourceTimestamp
          },
          environment: process.env.ALPACA_ENV === "live" ? "live" : "paper",
          configAllowlistVersion: "phase1b-v1",
          brokerRequestId: requestId,
          marketDataRequestId: stringValue(payload.marketDataRequestId),
          feed
          });
      const decisionId = existingSnapshot?.decision_id ?? newSnapshot!.decisionId;
      linkPaperReviewDecision({
        artifactId: input.artifactId,
        section,
        payloadIndex,
        decisionId,
        decisionRole: role
      });
      appendDecisionLifecycleEvent({
        decisionId,
        status: "REVIEWED",
        reasonCodes: reasonCodesFromPayload(payload),
        occurredAt: input.createdAt,
        sourceType: "paper_review_artifact",
        sourceId: originId,
        evidence: {
          artifactId: input.artifactId,
          payloadIndex,
          section,
          sourceAction: input.sourceAction
        }
      });
    });
  }
};

export const reviewedPayloadSignature = (sections: ReviewedPayloadSections) =>
  canonicalJsonHash(sections);

export const reviewedPayloadCount = (sections: ReviewedPayloadSections) =>
  Object.values(sections).reduce((total, entries) => total + entries.length, 0);

const safeParse = (value: string) => {
  try {
    return JSON.parse(value) as PaperReviewArtifact["artifact"];
  } catch {
    return {
      id: "unparseable",
      createdAt: new Date(0).toISOString(),
      expiresAt: new Date(0).toISOString(),
      sourceAction: "unknown",
      status: "failed",
      payloadSignature: "",
      payloadSections: emptySections(),
      summary: {},
      warnings: ["artifact_json_unparseable"],
      blockers: ["ARTIFACT_JSON_UNPARSEABLE"]
    };
  }
};

const mapRow = (row: PaperReviewArtifactRow): PaperReviewArtifact => ({
  id: row.id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  sourceAction: row.source_action,
  status: row.status,
  payloadSignature: row.payload_signature,
  payloadCount: row.payload_count,
  artifact: safeParse(row.artifact_json)
});

export const createPaperReviewArtifact = (input: {
  id?: string;
  sourceAction: string;
  status: string;
  payloadSections: ReviewedPayloadSections;
  summary: Record<string, unknown>;
  warnings?: string[];
  blockers?: string[];
  details?: Record<string, unknown>;
  createdAt?: string;
  maxAgeMinutes?: number;
}): PaperReviewArtifact => {
  const id = input.id ?? `pra_${randomUUID()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const maxAgeMinutes =
    input.maxAgeMinutes && input.maxAgeMinutes > 0 ? input.maxAgeMinutes : 30;
  const expiresAt = new Date(
    new Date(createdAt).getTime() + maxAgeMinutes * 60 * 1000
  ).toISOString();
  const payloadSections = {
    ...emptySections(),
    ...input.payloadSections
  };
  const payloadSignature = reviewedPayloadSignature(payloadSections);
  const artifact = {
    id,
    createdAt,
    expiresAt,
    sourceAction: input.sourceAction,
    status: input.status,
    payloadSignature,
    payloadSections,
    summary: input.summary,
    warnings: input.warnings ?? [],
    blockers: input.blockers ?? [],
    details: input.details
  };

  getDb()
    .prepare(
      `
      INSERT INTO paper_review_artifacts(
        id,
        created_at,
        expires_at,
        source_action,
        status,
        payload_signature,
        payload_count,
        artifact_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      id,
      createdAt,
      expiresAt,
      input.sourceAction,
      input.status,
      payloadSignature,
      reviewedPayloadCount(payloadSections),
      JSON.stringify(artifact)
    );

  persistArtifactDecisionLinks({
    artifactId: id,
    createdAt,
    sourceAction: input.sourceAction,
    payloadSections
  });

  return {
    id,
    createdAt,
    expiresAt,
    sourceAction: input.sourceAction,
    status: input.status,
    payloadSignature,
    payloadCount: reviewedPayloadCount(payloadSections),
    artifact
  };
};

export const findPaperReviewPayloadDecision = (input: {
  artifactId: string;
  section: ReviewedPayloadSectionName;
  payloadIndex: number;
}) =>
  queryOne<{
    decision_id: DecisionId;
    decision_role: DecisionRole;
    position_lifecycle_id: PositionLifecycleId | null;
  }>(
    `
    SELECT prd.decision_id, prd.decision_role, ds.position_lifecycle_id
    FROM paper_review_decisions prd
    JOIN decision_snapshots ds ON ds.decision_id = prd.decision_id
    WHERE prd.artifact_id = ? AND prd.section = ? AND prd.payload_index = ?
    ORDER BY prd.decision_id
    LIMIT 1
    `,
    [input.artifactId, input.section, input.payloadIndex]
  );

export const latestPaperReviewArtifact = (): PaperReviewArtifact | null => {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM paper_review_artifacts
      ORDER BY created_at DESC
      LIMIT 1
      `
    )
    .get() as PaperReviewArtifactRow | undefined;
  return row ? mapRow(row) : null;
};

export const listPaperReviewArtifacts = (limit = 10): PaperReviewArtifact[] =>
  queryAll<PaperReviewArtifactRow>(
    `
    SELECT *
    FROM paper_review_artifacts
    ORDER BY created_at DESC
    LIMIT ?
    `,
    [Math.min(50, Math.max(1, Math.floor(limit)))]
  ).map(mapRow);

export const isPaperReviewArtifactFresh = (
  artifact: Pick<PaperReviewArtifact, "expiresAt">,
  asOf = new Date().toISOString()
) => new Date(artifact.expiresAt).getTime() >= new Date(asOf).getTime();
