import { randomUUID } from "node:crypto";
import { canonicalJsonHash } from "../lib/canonicalJson.js";
import { getDb, queryAll } from "../lib/db.js";

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
