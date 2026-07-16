import type {
  FencedRepositoryOperationContext,
  JsonValue,
  TransactionScopedOperationContext
} from "./common.js";

export type ExecutionAssetClass = "equity" | "option";
export type ExecutionSide = "buy" | "sell" | "buy_to_open" | "sell_to_close";
export type ExecutionOrderType = "market" | "limit" | "stop" | "stop_limit";
export type ExecutionTimeInForce = "day" | "gtc" | "opg" | "cls" | "ioc" | "fok";

export interface ExecutionPositionProjection {
  readonly id: string;
  readonly brokerPositionKey: string;
  readonly candidateId: string | null;
  readonly openingOrderId: string | null;
  readonly closingOrderId: string | null;
  readonly symbol: string;
  readonly underlyingSymbol: string | null;
  readonly optionSymbol: string | null;
  readonly assetClass: ExecutionAssetClass;
  readonly side: "long" | "short";
  readonly quantity: string;
  readonly availableQuantity: string | null;
  readonly averageEntryPrice: string | null;
  readonly currentPrice: string | null;
  readonly marketValue: string | null;
  readonly costBasis: string | null;
  readonly unrealizedPnl: string | null;
  readonly realizedPnl: string | null;
  readonly openedAt: string;
}

export interface ExecutionAccountProjection {
  readonly accountId: string;
  readonly brokerAccountId: string;
  readonly accountSnapshotId: string;
  readonly observedAt: string;
  readonly accountStatus: string;
  readonly currency: string;
  readonly cash: string | null;
  readonly portfolioValue: string | null;
  readonly equity: string | null;
  readonly buyingPower: string | null;
  readonly optionsBuyingPower: string | null;
  readonly optionsApprovedLevel: number | null;
  readonly tradingBlocked: boolean;
  readonly accountBlocked: boolean;
  readonly snapshotFingerprint: string;
  readonly evidence: JsonValue;
  readonly positions: readonly ExecutionPositionProjection[];
  readonly riskLimit: {
    readonly id: string;
    readonly cashReserveAmount: string | null;
    readonly cashReserveRatio: string | null;
    readonly maxDeploymentAmount: string | null;
    readonly maxDeploymentRatio: string | null;
    readonly maxGrossExposure: string | null;
    readonly maxNetExposure: string | null;
    readonly maxOpenOrderExposure: string | null;
    readonly maxPositionNotional: string | null;
    readonly maxSymbolNotional: string | null;
    readonly maxPositionCount: number | null;
    readonly maxOrderCount: number | null;
    readonly configVersion: string;
    readonly configFingerprint: string;
  };
  readonly strategyAllocation: {
    readonly id: string;
    readonly strategyKey: string;
    readonly allocationAmount: string | null;
    readonly allocationRatio: string | null;
    readonly configVersion: string;
    readonly configFingerprint: string;
  };
  readonly exposure: {
    readonly id: string;
    readonly grossExposure: string;
    readonly netExposure: string;
    readonly longExposure: string;
    readonly shortExposure: string;
    readonly openOrderExposure: string;
    readonly activeReservationAmount: string;
    readonly deployedAmount: string;
    readonly cashReserveAmount: string;
    readonly availableBuyingPower: string | null;
    readonly positionCount: number;
    readonly openOrderCount: number;
    readonly fingerprint: string;
    readonly evidence: JsonValue;
  };
}

export interface ExecutionReservationIntentInput {
  readonly reservationId: string | null;
  readonly reservationRequired: boolean;
  readonly orderIntentId: string;
  readonly accountId: string;
  readonly accountSnapshotId: string;
  readonly candidateId: string | null;
  readonly strategyKey: string;
  readonly symbol: string;
  readonly underlyingSymbol?: string | null;
  readonly assetClass: ExecutionAssetClass;
  readonly amount: string;
  readonly idempotencyKey: string;
  readonly reservationFingerprint: string;
  readonly expiresAt: string;
  readonly clientOrderId: string;
  readonly side: ExecutionSide;
  readonly orderType: ExecutionOrderType;
  readonly timeInForce: ExecutionTimeInForce;
  readonly quantity: string | null;
  readonly notional: string | null;
  readonly limitPrice: string | null;
  readonly stopPrice: string | null;
  readonly estimatedPremium: string | null;
  readonly maxRisk: string | null;
  readonly intentFingerprint: string;
  readonly lifecycleFingerprint: string;
  readonly executionReviewId?: string | null;
  readonly confirmationEvidenceId?: string | null;
  readonly requestPayload: JsonValue;
  readonly requestId: string | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export type ExecutionReservationResult =
  | {
      readonly status: "authorized" | "duplicate";
      readonly reservationId: string | null;
      readonly orderIntentId: string;
    }
  | { readonly status: "blocked"; readonly blockers: readonly string[] }
  | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null };

export interface BrokerResultInput {
  readonly eventId: string;
  readonly orderId: string;
  readonly orderIntentId: string;
  readonly brokerOrderId: string | null;
  readonly clientOrderId: string;
  readonly brokerClientOrderId?: string;
  readonly replacesBrokerOrderId?: string | null;
  readonly symbol: string;
  readonly assetClass: ExecutionAssetClass;
  readonly side: ExecutionSide;
  readonly orderType: ExecutionOrderType;
  readonly timeInForce: ExecutionTimeInForce;
  readonly status: string;
  readonly quantity: string | null;
  readonly notional: string | null;
  readonly limitPrice: string | null;
  readonly stopPrice: string | null;
  readonly brokerQuantity?: string | null;
  readonly brokerNotional?: string | null;
  readonly brokerLimitPrice?: string | null;
  readonly brokerStopPrice?: string | null;
  readonly filledQuantity: string;
  readonly filledAveragePrice: string | null;
  readonly requestId: string | null;
  readonly httpStatus: number | null;
  readonly errorClassification: string | null;
  readonly retryable: boolean | null;
  readonly responsePayload: JsonValue;
  readonly responseFingerprint: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
}

export interface ExecutionReservationState {
  readonly symbol: string;
  readonly assetClass: ExecutionAssetClass;
  readonly side: ExecutionSide;
  readonly status: string;
  readonly quantity: string | null;
  readonly notional: string | null;
  readonly estimatedPremium: string | null;
  readonly limitPrice: string | null;
  readonly clientOrderId: string;
}

export interface ExecutionZeroDteActivityState {
  readonly ledger: readonly {
    readonly id: string;
    readonly createdAt: string;
    readonly assetClass: string;
    readonly symbol: string;
    readonly side: string | null;
    readonly status: string;
    readonly quantity: string | null;
    readonly limitPrice: string | null;
    readonly estimatedPremium: string | null;
    readonly clientOrderId: string | null;
    readonly brokerOrderId: string | null;
    readonly rawResponse: JsonValue;
  }[];
  readonly positions: readonly {
    readonly positionLifecycleId: string;
    readonly optionSymbol: string;
    readonly status: string;
    readonly brokerEntryOrderId: string | null;
    readonly entryClientOrderId: string | null;
    readonly openedAt: string;
    readonly closedAt: string | null;
    readonly entryQuantity: string | null;
    readonly entryPrice: string | null;
    readonly realizedPnl: string | null;
    readonly outcomeCompletenessStatus: string | null;
    readonly latestOutcomeRevisionJson: null;
  }[];
}

export interface BrokerReconciliationTarget {
  readonly orderIntentId: string;
  readonly orderId: string | null;
  readonly accountId: string;
  readonly clientOrderId: string;
  readonly brokerOrderId?: string | null;
  readonly brokerClientOrderId?: string;
  readonly symbol: string;
  readonly underlyingSymbol: string | null;
  readonly assetClass: ExecutionAssetClass;
  readonly side: ExecutionSide;
  readonly orderType: ExecutionOrderType;
  readonly timeInForce: ExecutionTimeInForce;
  readonly quantity: string | null;
  readonly notional: string | null;
  readonly limitPrice: string | null;
  readonly stopPrice: string | null;
  readonly brokerQuantity?: string | null;
  readonly brokerNotional?: string | null;
  readonly brokerLimitPrice?: string | null;
  readonly brokerStopPrice?: string | null;
  readonly intentStatus: string;
  readonly createdAt: string;
}

export interface ExecutionEvidenceInput {
  readonly accountId: string;
  readonly candidateId: string | null;
  readonly review: {
    readonly id: string;
    readonly reviewType: "entry" | "exit";
    readonly status: "created" | "valid" | "blocked" | "expired" | "consumed" | "revoked";
    readonly clientOrderId: string | null;
    readonly accountFingerprint: string;
    readonly sourceRecommendationId: string | null;
    readonly sourceSnapshotId: string | null;
    readonly configurationFingerprint: string;
    readonly payloadFingerprint: string;
    readonly signatureAlgorithm: string;
    readonly signature: string;
    readonly orderIntent: JsonValue;
    readonly marketEvidence: JsonValue;
    readonly portfolioEvidence: JsonValue;
    readonly warnings: JsonValue;
    readonly blockers: JsonValue;
    readonly requestId: string | null;
    readonly correlationId: string | null;
    readonly expiresAt: string;
    readonly createdAt: string;
  };
  readonly confirmation: {
    readonly id: string;
    readonly evidenceType: string;
    readonly confirmationMethod: string;
    readonly status: "valid" | "expired" | "consumed" | "revoked";
    readonly payloadFingerprint: string;
    readonly signatureAlgorithm: string | null;
    readonly signature: string | null;
    readonly evidence: JsonValue;
    readonly confirmedAt: string;
    readonly expiresAt: string;
  };
  readonly lifecycleFingerprint: {
    readonly id: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly lifecycleStage: string;
    readonly fingerprint: string;
    readonly payloadVersion: number;
    readonly evidence: JsonValue;
    readonly requestId: string | null;
    readonly correlationId: string | null;
    readonly capturedAt: string;
  };
}

export interface ExecutionStateRepository<TTransaction> {
  findCurrentAccount(
    context: TransactionScopedOperationContext<TTransaction>
  ): Promise<{
    readonly accountId: string;
    readonly accountSnapshotId: string;
    readonly strategyKey: string;
  } | null>;
  listActiveReservations(
    context: TransactionScopedOperationContext<TTransaction>
  ): Promise<readonly ExecutionReservationState[]>;
  listZeroDteActivityState(
    input: { readonly tradingDate: string },
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | ({ readonly status: "listed" } & ExecutionZeroDteActivityState)
    | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null }
  >;
  listBrokerReconciliationTargets(
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | {
        readonly status: "listed";
        readonly targets: readonly BrokerReconciliationTarget[];
      }
    | {
        readonly status: "fence_rejected";
        readonly currentFencingToken: string | null;
      }
  >;
  authorizeBrokerMutation(
    input: {
      readonly accountId: string;
      readonly orderIntentId: string;
      readonly clientOrderId: string;
      readonly brokerOrderId: string;
      readonly mutation: "replace" | "cancel";
    },
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | { readonly status: "authorized" }
    | { readonly status: "blocked"; readonly blockers: readonly string[] }
    | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null }
  >;
  syncAccountState(
    input: ExecutionAccountProjection,
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | { readonly status: "synced"; readonly accountId: string; readonly snapshotId: string }
    | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null }
  >;
  reserveAndCreateOrderIntent(
    input: ExecutionReservationIntentInput,
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<ExecutionReservationResult>;
  recordBrokerResult(
    input: BrokerResultInput,
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | { readonly status: "recorded" | "duplicate"; readonly orderId: string }
    | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null }
  >;
  upsertExecutionEvidence(
    input: ExecutionEvidenceInput,
    context: FencedRepositoryOperationContext<TTransaction>
  ): Promise<
    | { readonly status: "stored" }
    | { readonly status: "fence_rejected"; readonly currentFencingToken: string | null }
  >;
}
