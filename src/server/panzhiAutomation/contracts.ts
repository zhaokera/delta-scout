import { z } from "zod";

export const PanzhiAutomationModeSchema = z.enum(["quick", "deep"]);

export const PanzhiAutomationStateSchema = z.enum([
  "queued",
  "opening_page",
  "applying_filters",
  "collecting",
  "awaiting_user_verification",
  "submitting",
  "success",
  "failed",
  "cancelled"
]);

export const PanzhiAutomationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

const IsoTimestampSchema = z.iso.datetime({ offset: true });

export const PanzhiAutomationJobSchema = z.strictObject({
  id: z.uuid(),
  mode: PanzhiAutomationModeSchema,
  state: PanzhiAutomationStateSchema,
  leaseExpiresAt: IsoTimestampSchema.nullable(),
  verificationDeadlineAt: IsoTimestampSchema.nullable(),
  verificationNotifiedAt: IsoTimestampSchema.nullable(),
  normalizedRequestDigest: PanzhiAutomationDigestSchema.nullable(),
  error: z.string().nullable(),
  scanRunId: z.number().int().positive().nullable(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema.nullable()
});

export const PanzhiAutomationExtensionHeartbeatSchema = z.strictObject({
  connected: z.boolean(),
  lastHeartbeatAt: IsoTimestampSchema.nullable()
});

export const PanzhiAutomationStatusSchema =
  PanzhiAutomationExtensionHeartbeatSchema.extend({
    currentJob: PanzhiAutomationJobSchema.nullable()
  });

export const PanzhiAutomationEnqueueResponseSchema = z.strictObject({
  job: PanzhiAutomationJobSchema,
  created: z.boolean(),
  upgraded: z.boolean()
});

export const PanzhiAutomationClaimResponseSchema = z.strictObject({
  job: PanzhiAutomationJobSchema,
  bearerToken: z.string().min(43).max(64)
});

export const PanzhiAutomationHeartbeatResponseSchema = z.strictObject({
  job: PanzhiAutomationJobSchema,
  leaseExpiresAt: IsoTimestampSchema
});

export const PanzhiAutomationStateResponseSchema = z.strictObject({
  job: PanzhiAutomationJobSchema
});

export const PanzhiAutomationCancelResponseSchema =
  PanzhiAutomationStateResponseSchema;

export const PanzhiAutomationCompletionResponseSchema =
  PanzhiAutomationStateResponseSchema;

export type PanzhiAutomationMode = z.infer<
  typeof PanzhiAutomationModeSchema
>;
export type PanzhiAutomationState = z.infer<
  typeof PanzhiAutomationStateSchema
>;
export type PanzhiAutomationJob = z.infer<
  typeof PanzhiAutomationJobSchema
>;
export type PanzhiAutomationExtensionHeartbeat = z.infer<
  typeof PanzhiAutomationExtensionHeartbeatSchema
>;
export type PanzhiAutomationStatus = z.infer<
  typeof PanzhiAutomationStatusSchema
>;
export type PanzhiAutomationEnqueueResponse = z.infer<
  typeof PanzhiAutomationEnqueueResponseSchema
>;
export type PanzhiAutomationClaimResponse = z.infer<
  typeof PanzhiAutomationClaimResponseSchema
>;
export type PanzhiAutomationHeartbeatResponse = z.infer<
  typeof PanzhiAutomationHeartbeatResponseSchema
>;
export type PanzhiAutomationStateResponse = z.infer<
  typeof PanzhiAutomationStateResponseSchema
>;
export type PanzhiAutomationCancelResponse = z.infer<
  typeof PanzhiAutomationCancelResponseSchema
>;
export type PanzhiAutomationCompletionResponse = z.infer<
  typeof PanzhiAutomationCompletionResponseSchema
>;

const TERMINAL_STATES: ReadonlySet<PanzhiAutomationState> = new Set([
  "success",
  "failed",
  "cancelled"
]);

const TRANSITIONS: Readonly<
  Record<PanzhiAutomationState, ReadonlySet<PanzhiAutomationState>>
> = {
  queued: new Set(["opening_page", "failed", "cancelled"]),
  opening_page: new Set(["applying_filters", "failed", "cancelled"]),
  applying_filters: new Set(["collecting", "failed", "cancelled"]),
  collecting: new Set([
    "awaiting_user_verification",
    "submitting",
    "failed",
    "cancelled"
  ]),
  awaiting_user_verification: new Set([
    "collecting",
    "submitting",
    "failed",
    "cancelled"
  ]),
  submitting: new Set(["success", "failed", "cancelled"]),
  success: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

export function isTerminalPanzhiAutomationState(
  state: PanzhiAutomationState
): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionPanzhiAutomationJob(
  current: PanzhiAutomationState,
  next: PanzhiAutomationState
): boolean {
  return TRANSITIONS[current].has(next);
}
