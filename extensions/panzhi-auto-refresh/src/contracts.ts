export const PANZHI_CATALOG_URL =
  "https://www.pzds.com/goodsList/391/6" as const;

export const PANZHI_REQUIRED_OPERATOR_SKINS = [
  {
    optionId: "1038173",
    label: "骇爪-维什戴尔",
    metadataCode: "SA200018"
  },
  {
    optionId: "1035794",
    label: "露娜-黑天际线",
    metadataCode: "SA200003"
  }
] as const;

export type PanzhiPageMode = "quick" | "deep";

export type PanzhiPageStage =
  | "applying_filters"
  | "collecting"
  | "awaiting_user_verification"
  | "submitting";

export type VerificationBlocker = "captcha" | "slider" | "login";

export type PageRunnerFailureCode =
  | "missing_controls"
  | "structural_drift"
  | "collection_limit"
  | "operation_timeout";

export interface PanzhiSnapshotItem {
  sourceListingId: string;
  url: string;
  title: string;
  rawText: string;
  priceCny: number;
}

export interface PanzhiFilterProof {
  currentUrl: typeof PANZHI_CATALOG_URL;
  gameLabel: "三角洲行动";
  minPriceInput: "1900";
  maxPriceInput: "4000";
  secondRealNameFilter: {
    label: "可二次实名";
    selected: true;
  };
  operatorSkinFilter: {
    fieldId: "22858";
    fieldLabel: "特战干员外观";
    fieldType: "CHECKBOX";
    mappingField: "22858";
    searchType: "ALL";
    searchTypeLabel: "全部都要有";
    selectedOptions: Array<{
      optionId: "1038173" | "1035794";
      label: "骇爪-维什戴尔" | "露娜-黑天际线";
      metadataCode: "SA200018" | "SA200003";
    }>;
  };
  observedAt: string;
}

export interface PanzhiPageSnapshot {
  mode: PanzhiPageMode;
  filterProof: PanzhiFilterProof;
  loadActionCount: number;
  observedUniqueCount: number;
  stopReason: "quick_window" | "no_growth_twice";
  items: PanzhiSnapshotItem[];
}

export type PageRunnerResult =
  | {
      kind: "snapshot";
      stage: "submitting";
      snapshot: PanzhiPageSnapshot;
    }
  | {
      kind: "awaiting_user_verification";
      stage: "awaiting_user_verification";
      blocker: VerificationBlocker;
      resumeStage: "applying_filters";
    }
  | {
      kind: "failure";
      stage: "applying_filters" | "collecting";
      code: PageRunnerFailureCode;
      message: string;
      loadActionCount?: number;
    };

export interface PageRunnerDependencies {
  document: Document;
  currentUrl: () => string;
  now: () => Date;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  loadMore: () => Promise<void>;
  mutationTimeoutMs: number;
  onStage: (stage: PanzhiPageStage) => void | Promise<void>;
}
