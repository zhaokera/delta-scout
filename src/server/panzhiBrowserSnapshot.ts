import { z } from "zod";
import { toEvidenceRecords } from "../domain/evidence.js";
import type { Listing } from "../domain/listing.js";
import { isCandidatePriceCny } from "../domain/priceRange.js";
import { buildListing } from "./collector/buildListing.js";
import type { ListingDetail } from "./collector/types.js";

export const PANZHI_CATALOG_URL =
  "https://www.pzds.com/goodsList/391/6";

const DateTimeSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected an ISO 8601 date-time"
  });

const PanzhiCatalogUrlSchema = z.string().refine((value) => {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://www.pzds.com" &&
      url.pathname.replace(/\/$/, "") === "/goodsList/391/6" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "Expected the approved Panzhi Delta Force catalog URL");

const PanzhiRequiredOperatorSkinSchema = z.discriminatedUnion("optionId", [
  z.strictObject({
    optionId: z.literal("1038173"),
    label: z.literal("骇爪-维什戴尔"),
    metadataCode: z.literal("SA200018")
  }),
  z.strictObject({
    optionId: z.literal("1035794"),
    label: z.literal("露娜-黑天际线"),
    metadataCode: z.literal("SA200003")
  })
]);

const PanzhiRequiredOperatorSkinsSchema = z
  .array(PanzhiRequiredOperatorSkinSchema)
  .length(2)
  .superRefine((options, context) => {
    if (new Set(options.map(({ optionId }) => optionId)).size !== 2) {
      context.addIssue({
        code: "custom",
        message: "Expected both required Panzhi operator skin options"
      });
    }
  });

function isCanonicalDetailUrl(
  value: string,
  sourceListingId: string
): boolean {
  if (value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === "https://www.pzds.com" &&
      url.pathname === `/goodsDetails/${sourceListingId}/6` &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export const PanzhiBrowserSnapshotItemSchema = z
  .strictObject({
    sourceListingId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    url: z.string().url().max(300),
    title: z.string().trim().min(1).max(500),
    rawText: z.string().trim().min(1).max(4_000),
    priceCny: z.number().finite().nonnegative().max(100_000_000)
  })
  .superRefine((item, context) => {
    if (!isCanonicalDetailUrl(item.url, item.sourceListingId)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Panzhi detail URL does not match the listing id"
      });
    }
  });

export const PanzhiBrowserSnapshotSchema = z
  .strictObject({
    filterProof: z.strictObject({
      currentUrl: PanzhiCatalogUrlSchema,
      gameLabel: z.literal("三角洲行动"),
      minPriceInput: z.literal("1900"),
      maxPriceInput: z.literal("4000"),
      operatorSkinFilter: z.strictObject({
        fieldId: z.literal("22858"),
        fieldLabel: z.literal("特战干员外观"),
        fieldType: z.literal("CHECKBOX"),
        mappingField: z.literal("22858"),
        searchType: z.literal("ALL"),
        searchTypeLabel: z.literal("全部都要有"),
        selectedOptions: PanzhiRequiredOperatorSkinsSchema
      }),
      observedAt: DateTimeSchema
    }),
    loadActionCount: z.number().int().min(2).max(100),
    observedUniqueCount: z.number().int().min(1).max(500),
    stopReason: z.enum(["no_growth_twice", "captcha_required"]),
    items: z.array(PanzhiBrowserSnapshotItemSchema).min(1).max(500)
  })
  .superRefine((snapshot, context) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const [index, item] of snapshot.items.entries()) {
      if (ids.has(item.sourceListingId)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "sourceListingId"],
          message: "Duplicate Panzhi listing id"
        });
      }
      if (urls.has(item.url)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "url"],
          message: "Duplicate Panzhi listing URL"
        });
      }
      ids.add(item.sourceListingId);
      urls.add(item.url);
    }
    if (snapshot.observedUniqueCount !== ids.size) {
      context.addIssue({
        code: "custom",
        path: ["observedUniqueCount"],
        message: "Observed count must match the unique card count"
      });
    }
    if (!snapshot.items.some(({ priceCny }) =>
      isCandidatePriceCny(priceCny)
    )) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Snapshot has no listing inside the candidate price range"
      });
    }
  });

export type PanzhiBrowserSnapshot = z.infer<
  typeof PanzhiBrowserSnapshotSchema
>;

function detailFromVisibleCard(rawText: string): ListingDetail {
  const hasQq = /(?:^|\s)QQ(?:\s|可|不|$)/i.test(rawText);
  const hasWechat = /微信/.test(rawText);
  const loginPlatform = hasQq === hasWechat
    ? "unknown"
    : hasQq
      ? "qq"
      : "wechat";
  const cannotSecond = /不可二次实名/.test(rawText);
  const canSecond = !cannotSecond && /可二次实名/.test(rawText);
  const noCoverage = /不支持.{0,8}包赔|无包赔/.test(rawText);
  const hasCoverage =
    !noCoverage && /支持.{0,8}包赔|人脸包赔|找回包赔|永久包赔/.test(rawText);

  return {
    evidence: toEvidenceRecords([rawText]),
    loginPlatform,
    service: loginPlatform === "qq" ? "official" : "unknown",
    totalAssetsM: null,
    hafCoins: null,
    realNameStatus: cannotSecond
      ? "already_second"
      : canSecond
        ? "second_available"
        : "unknown",
    secondRealNameAvailable: cannotSecond
      ? false
      : canSecond
        ? true
        : null,
    recoveryCoverage: noCoverage ? false : hasCoverage ? true : null,
    verificationAt: null,
    banNotes: /有封号|封禁记录/.test(rawText)
      ? ["页面卡片提示存在封号记录"]
      : []
  };
}

function normalizePanzhiVisibleCardText(rawText: string): string {
  // Panzhi cards abbreviate the target skin as `M7棱镜(优品B)` while their
  // detail page uses the full `M7棱镜攻势` name. Keep this normalization
  // scoped to verified Panzhi cards so the shared evidence parser can retain
  // its stricter false-positive protection for other sources.
  return rawText.replace(
    /M7\s*棱镜(?=\s*[（(]?\s*(?:极品|优品))/gi,
    "M7棱镜攻势"
  );
}

export function buildPanzhiBrowserListings(
  snapshot: PanzhiBrowserSnapshot,
  capturedAt: Date
): {
  listings: Listing[];
  droppedByPrice: number;
} {
  const inRangeItems = snapshot.items.filter(({ priceCny }) =>
    isCandidatePriceCny(priceCny)
  );
  return {
    droppedByPrice: snapshot.items.length - inRangeItems.length,
    listings: inRangeItems.map((item) => {
      const normalizedRawText = normalizePanzhiVisibleCardText(item.rawText);
      return buildListing({
        summary: {
          source: "panzhi",
          sourceListingId: item.sourceListingId,
          url: item.url,
          title: item.title,
          rawText: normalizedRawText,
          priceCny: item.priceCny
        },
        detail: detailFromVisibleCard(normalizedRawText),
        detailAttempted: true,
        warnings: []
      },
      capturedAt);
    })
  };
}
