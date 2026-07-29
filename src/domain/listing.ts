import { z } from "zod";

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
export const JulangStatusSchema = z.enum(["unknown", "absent", "owned"]);
export const RealNameStatusSchema = z.enum([
  "unknown",
  "original",
  "second_available",
  "already_second"
]);

export const EvidenceRecordSchema = z.object({
  text: z.string().max(2_000),
  truncated: z.boolean()
});

export const ScoreSchema = z.object({
  total: z.number().int().min(0).max(100),
  value: z.number().min(0).max(100),
  safety: z.number().min(0).max(100),
  dataQuality: z.number().min(0).max(100),
  riskLevel: z.enum(["low", "medium", "high", "unknown"]),
  coverage: z.object({
    knownSafetySignals: z.number().int().min(0).max(3),
    totalSafetySignals: z.literal(3)
  }),
  parts: z.object({
    m7: z.number().min(0).max(35),
    redSkins: z.number().min(0).max(20),
    julang: z.number().min(0).max(15),
    price: z.number().min(0).max(20),
    assets: z.number().min(0).max(10),
    secondRealName: z.number().min(0).max(40),
    recovery: z.number().min(0).max(35),
    verification: z.number().min(0).max(25)
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
  redSkins: z.array(z.string().min(1)),
  redSkinCount: z.number().int().nonnegative().nullable(),
  redSkinUnnamed: z.boolean(),
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
});

export type SourceId = z.infer<typeof SourceIdSchema>;
export type LoginPlatform = z.infer<typeof LoginPlatformSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Eligibility = z.infer<typeof EligibilitySchema>;
export type RealNameStatus = z.infer<typeof RealNameStatusSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Score = z.infer<typeof ScoreSchema>;
