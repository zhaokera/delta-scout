import { z } from "zod";

export const BROWSER_REFRESH_SOURCE = "jiaoyimao" as const;

export const BROWSER_REFRESH_LIMITS = {
  maxListItemsPerBatch: 25,
  maxDetailsPerBatch: 5,
  maxUniqueItems: 2_000,
  maxLoadEvents: 100,
  maxTitleChars: 500,
  maxCardTextChars: 4_000,
  maxSectionChars: 12_000,
  maxCombinedDetailTextChars: 32_000,
  maxFilterLabelChars: 100,
  maxClaimCodeChars: 64,
  maxPauseMessageChars: 500,
  maxBatchUtf8Bytes: 131_072
} as const;

const APPROVED_ORIGIN = "https://www.jiaoyimao.com";
const APPROVED_FILTER_PATH =
  "/jg2007840/f8845003-c8845004/o110/";
const DETAIL_PATH_PATTERN = /^\/jg2007840\/(\d+)\.html$/;
const FORBIDDEN_VISIBLE_TEXT_PATTERNS = [
  /cookie\s*[:=]/i,
  /set-cookie/i,
  /authorization\s*[:=]/i,
  /bearer\s+\S+/i,
  /_m_h5_tk/i,
  /password\s*[:=]/i,
  /验证码答案\s*[:=]/i,
  /校验码\s*[:=]/i,
  /<script/i,
  /javascript:/i,
  /<\/?[A-Za-z][A-Za-z0-9:-]*[^>]*>/i,
  /<!(?:--|doctype\b|\[CDATA\[)/i
] as const;

function containsForbiddenVisibleText(value: string): boolean {
  return FORBIDDEN_VISIBLE_TEXT_PATTERNS.some((pattern) =>
    pattern.test(value)
  );
}

function safeVisibleText(maximum: number, minimum = 0) {
  return z.string()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => !containsForbiddenVisibleText(value),
      "Visible text contains forbidden sensitive or script content"
    );
}

export const SafeVisibleTextSchema = z.string().refine(
  (value) => !containsForbiddenVisibleText(value),
  "Visible text contains forbidden sensitive or script content"
);

export const SafeFilterLabelSchema = safeVisibleText(
  BROWSER_REFRESH_LIMITS.maxFilterLabelChars,
  1
);
export const SafeTitleSchema = safeVisibleText(
  BROWSER_REFRESH_LIMITS.maxTitleChars,
  1
);
export const SafeCardTextSchema = safeVisibleText(
  BROWSER_REFRESH_LIMITS.maxCardTextChars
);
export const SafeSectionSchema = safeVisibleText(
  BROWSER_REFRESH_LIMITS.maxSectionChars
);
export const SafePauseMessageSchema = safeVisibleText(
  BROWSER_REFRESH_LIMITS.maxPauseMessageChars
);

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });
export const DigitIdSchema = z.string().regex(/^\d+$/);

function parseApprovedUrl(value: string): URL | null {
  if (
    value.trim() !== value ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    value.includes("#") ||
    value.indexOf("?") === value.length - 1
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.origin === APPROVED_ORIGIN &&
      url.toString() === value &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.hash === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

export const JiaoyimaoFilterUrlSchema = z.string().refine((value) => {
  const url = parseApprovedUrl(value);
  return url !== null && url.pathname === APPROVED_FILTER_PATH;
}, "Expected the approved Jiaoyimao game catalog URL");

export const JiaoyimaoDetailUrlSchema = z.string().refine((value) => {
  const url = parseApprovedUrl(value);
  return url !== null && DETAIL_PATH_PATTERN.test(url.pathname);
}, "Expected a canonical Jiaoyimao detail URL");

function detailUrlId(value: string): string | null {
  const url = parseApprovedUrl(value);
  return url?.pathname.match(DETAIL_PATH_PATTERN)?.[1] ?? null;
}

function addMatchingDetailIdIssue(
  value: { sourceListingId: string; url: string },
  context: z.RefinementCtx
): void {
  if (detailUrlId(value.url) !== value.sourceListingId) {
    context.addIssue({
      code: "custom",
      path: ["url"],
      message: "Detail URL ID must match sourceListingId"
    });
  }
}

function withinBatchByteLimit(value: unknown): boolean {
  return (
    Buffer.byteLength(JSON.stringify(value), "utf8") <=
    BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes
  );
}

export const BrowserRefreshJobStateSchema = z.enum([
  "awaiting_codex",
  "collecting_list",
  "collecting_details",
  "awaiting_user_verification",
  "cooling_down",
  "validating",
  "committing",
  "success",
  "quarantined",
  "paused",
  "failed",
  "cancelled",
  "expired"
]);

export const BrowserFilterProofSchema = z.strictObject({
  currentUrl: JiaoyimaoFilterUrlSchema,
  gameLabel: SafeFilterLabelSchema,
  platformLabel: SafeFilterLabelSchema,
  categoryLabel: SafeFilterLabelSchema,
  m7FilterLabels: z.array(SafeFilterLabelSchema).min(4).max(8),
  observedAt: IsoDateTimeSchema
});

export const BrowserListItemSchema = z.strictObject({
  sourceListingId: DigitIdSchema,
  url: JiaoyimaoDetailUrlSchema,
  title: SafeTitleSchema,
  rawText: SafeCardTextSchema,
  priceCny: z.number().finite().nonnegative().nullable()
}).superRefine(addMatchingDetailIdIssue);

export const BrowserListBatchSchema = z.strictObject({
  sequence: z.number().int().positive(),
  observedAt: IsoDateTimeSchema,
  items: z.array(BrowserListItemSchema)
    .min(1)
    .max(BROWSER_REFRESH_LIMITS.maxListItemsPerBatch)
}).refine(
  withinBatchByteLimit,
  `Batch exceeds ${BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes} UTF-8 bytes`
);

export const BrowserLoadEventSchema = z.strictObject({
  sequence: z.number().int().positive(),
  observedUniqueCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems),
  newItemCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems),
  visibleTotalCount: z.number().int().nonnegative()
    .max(BROWSER_REFRESH_LIMITS.maxUniqueItems)
    .nullable(),
  endMarkerVisible: z.boolean(),
  loadingVisible: z.boolean(),
  blockingState: z.enum([
    "none",
    "login",
    "captcha",
    "rate_limited",
    "error"
  ]),
  observedAt: IsoDateTimeSchema,
  actionPermit: z.string().max(128).optional()
});

export const BrowserVisibleSectionsSchema = z.strictObject({
  head: SafeSectionSchema,
  report: SafeSectionSchema,
  safety: SafeSectionSchema,
  description: SafeSectionSchema
}).refine(
  (sections) =>
    Object.values(sections).reduce(
      (total, section) => total + section.length,
      0
    ) <= BROWSER_REFRESH_LIMITS.maxCombinedDetailTextChars,
  `Combined detail text exceeds ${
    BROWSER_REFRESH_LIMITS.maxCombinedDetailTextChars
  } characters`
);

export const BrowserDetailInputSchema = z.strictObject({
  sourceListingId: DigitIdSchema,
  url: JiaoyimaoDetailUrlSchema,
  observedAt: IsoDateTimeSchema,
  sections: BrowserVisibleSectionsSchema
}).superRefine(addMatchingDetailIdIssue);

export const BrowserDetailBatchSchema = z.strictObject({
  sequence: z.number().int().positive(),
  items: z.array(BrowserDetailInputSchema)
    .min(1)
    .max(BROWSER_REFRESH_LIMITS.maxDetailsPerBatch),
  actionPermit: z.string().max(128).optional()
}).refine(
  withinBatchByteLimit,
  `Batch exceeds ${BROWSER_REFRESH_LIMITS.maxBatchUtf8Bytes} UTF-8 bytes`
);

export const BrowserPauseReasonSchema = z.enum([
  "login_required",
  "captcha_required",
  "rate_limited",
  "structure_changed",
  "no_progress",
  "safety_limit"
]);

export const BrowserPauseSchema = z.strictObject({
  reason: BrowserPauseReasonSchema,
  message: SafePauseMessageSchema.optional()
});

export const BrowserCooldownSchema = z.strictObject({
  reason: z.literal("rate_limited")
});

export type BrowserRefreshJobState = z.infer<
  typeof BrowserRefreshJobStateSchema
>;
export type BrowserFilterProof = z.infer<typeof BrowserFilterProofSchema>;
export type BrowserListItem = z.infer<typeof BrowserListItemSchema>;
export type BrowserListBatch = z.infer<typeof BrowserListBatchSchema>;
export type BrowserLoadEvent = z.infer<typeof BrowserLoadEventSchema>;
export type BrowserDetailInput = z.infer<typeof BrowserDetailInputSchema>;
export type BrowserDetailBatch = z.infer<typeof BrowserDetailBatchSchema>;
export type BrowserPause = z.infer<typeof BrowserPauseSchema>;
export type BrowserCooldown = z.infer<typeof BrowserCooldownSchema>;
