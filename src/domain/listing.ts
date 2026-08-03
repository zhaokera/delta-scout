import { z } from "zod";
import {
  SAFETY_SCORE_MAX,
  VALUE_SCORE_MAX
} from "./scoreAllocation.js";

export const SourceIdSchema = z.enum(["jiaoyimao", "panzhi", "pxb7"]);
export const LoginPlatformSchema = z.enum(["qq", "wechat", "unknown"]);
export const ServiceSchema = z.enum(["official", "non_official", "unknown"]);
export const EligibilitySchema = z.enum([
  "eligible",
  "needs_verification",
  "rejected"
]);
export const M7PrismStatusSchema = z.enum([
  "absent",
  "unknown",
  "premium",
  "peak",
  "conflicting"
]);
export const M7RareFinishSchema = z.enum([
  "pearl",
  "iridescent",
  "candy"
]);
export const JulangStatusSchema = z.enum(["unknown", "absent", "owned"]);
export const RealNameStatusSchema = z.enum([
  "unknown",
  "original",
  "second_available",
  "already_second"
]);
export const RequiredRedSkinSchema = z.enum([
  "骇爪-维什戴尔",
  "露娜-黑天际线"
]);
export const RequiredRedSkinStatusSchema = z.enum([
  "complete",
  "partial",
  "missing",
  "unknown"
]);

export const EvidenceRecordSchema = z.object({
  text: z.string().max(2_000),
  truncated: z.boolean()
});

export const ScoreSchema = z.object({
  total: z.number().int().min(0).max(100),
  exactTotal: z.number().min(0).max(100).optional(),
  preferenceAdjustment: z.number().int().min(-8).max(0).default(0),
  value: z.number().min(0).max(100),
  safety: z.number().min(0).max(SAFETY_SCORE_MAX.total),
  dataQuality: z.number().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high", "unknown"]),
  coverage: z.object({
    knownSafetySignals: z.number().int().min(0).max(1),
    totalSafetySignals: z.literal(1)
  }),
  parts: z.object({
    m7: z.number().min(0).max(VALUE_SCORE_MAX.m7),
    redSkins: z.number().min(0).max(VALUE_SCORE_MAX.redSkins),
    julang: z.number().min(0).max(VALUE_SCORE_MAX.julang),
    price: z.number().min(0).max(VALUE_SCORE_MAX.price),
    assets: z.number().min(0).max(VALUE_SCORE_MAX.assets),
    secondRealName: z.number().min(0).max(SAFETY_SCORE_MAX.secondRealName),
    recovery: z.literal(0),
    verification: z.literal(0)
  }),
  valueReasons: z.array(z.string()),
  safetyReasons: z.array(z.string()),
  reasons: z.array(z.string())
});

const DateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected an ISO 8601 date-time"
  });

export const ListingSchema = z.object({
  key: z.string().min(1),
  source: SourceIdSchema,
  sourceListingId: z.string().min(1).nullable(),
  url: z.url(),
  title: z.string().min(1),
  originalDescription: z.string(),
  capturedAt: DateTimeSchema,
  priceCny: z.number().nonnegative().nullable(),
  loginPlatform: LoginPlatformSchema,
  service: ServiceSchema,
  totalAssetsM: z.number().nonnegative().nullable(),
  hafCoins: z.number().nonnegative().nullable(),
  evidence: z.array(EvidenceRecordSchema),
  m7PrismStatus: M7PrismStatusSchema,
  m7PrismQuality: z
    .enum(["S", "A", "B", "C"])
    .nullable()
    .default(null),
  m7Evidence: z.array(EvidenceRecordSchema),
  m7RareFinishes: z.array(M7RareFinishSchema).default([]),
  m7RareFinishEvidence: z
    .array(EvidenceRecordSchema)
    .default([]),
  redSkins: z.array(z.string().min(1)),
  redSkinCount: z.number().int().nonnegative().nullable(),
  redSkinUnnamed: z.boolean(),
  requiredRedSkins: z.array(RequiredRedSkinSchema).default([]),
  requiredRedSkinStatus: RequiredRedSkinStatusSchema.default("unknown"),
  julangStatus: JulangStatusSchema,
  julangQuality: z.string().min(1).nullable(),
  realNameStatus: RealNameStatusSchema,
  secondRealNameAvailable: z.boolean().nullable(),
  recoveryCoverage: z.boolean().nullable(),
  verificationAt: DateTimeSchema.nullable(),
  banNotes: z.array(z.string()),
  parseWarnings: z.array(z.string()),
  confidence: z.number().int().min(0).max(100),
  eligibility: EligibilitySchema,
  score: ScoreSchema.nullable(),
  possibleDuplicateKeys: z.array(z.string()),
  scanStability: z
    .enum(["unknown", "new", "changed", "stable"])
    .default("unknown"),
  consecutiveUnchangedScans: z
    .number()
    .int()
    .nonnegative()
    .default(0)
}).superRefine((listing, context) => {
  const uniqueRequiredSkins = new Set(listing.requiredRedSkins);
  if (uniqueRequiredSkins.size !== listing.requiredRedSkins.length) {
    context.addIssue({
      code: "custom",
      path: ["requiredRedSkins"],
      message: "Required red skins must be unique"
    });
  }
  if (
    listing.requiredRedSkinStatus === "complete" &&
    uniqueRequiredSkins.size !== 2
  ) {
    context.addIssue({
      code: "custom",
      path: ["requiredRedSkinStatus"],
      message: "Complete required red-skin evidence needs both skins"
    });
  }
  if (
    listing.requiredRedSkinStatus === "partial" &&
    uniqueRequiredSkins.size !== 1
  ) {
    context.addIssue({
      code: "custom",
      path: ["requiredRedSkinStatus"],
      message: "Partial required red-skin evidence needs one skin"
    });
  }
  if (
    listing.requiredRedSkinStatus === "unknown" &&
    uniqueRequiredSkins.size !== 0
  ) {
    context.addIssue({
      code: "custom",
      path: ["requiredRedSkinStatus"],
      message: "Unknown required red-skin evidence cannot claim a skin"
    });
  }
});

export type SourceId = z.infer<typeof SourceIdSchema>;
export type LoginPlatform = z.infer<typeof LoginPlatformSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Eligibility = z.infer<typeof EligibilitySchema>;
export type RealNameStatus = z.infer<typeof RealNameStatusSchema>;
export type M7RareFinish = z.infer<typeof M7RareFinishSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Score = z.infer<typeof ScoreSchema>;
