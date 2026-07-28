export interface EvidenceRecord {
  text: string;
  truncated: boolean;
}

export type M7PrismStatus =
  | "absent"
  | "unknown"
  | "premium"
  | "peak"
  | "conflicting";

export interface EvidenceMatch<TStatus extends string> {
  status: TStatus;
  evidence: EvidenceRecord[];
}

const MAX_EVIDENCE_LENGTH = 2_000;

const DEFAULT_CHARACTER_ALIASES = [
  "威龙",
  "露娜",
  "无名",
  "红狼",
  "骇爪",
  "蜂医",
  "牧羊人",
  "乌鲁鲁",
  "深蓝",
  "蛊",
  "疾风"
] as const;

export function toEvidenceRecords(lines: string[]): EvidenceRecord[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const characters = [...line];
      return {
        text: characters.slice(0, MAX_EVIDENCE_LENGTH).join(""),
        truncated: characters.length > MAX_EVIDENCE_LENGTH
      };
    });
}

export function parseM7(
  records: EvidenceRecord[]
): EvidenceMatch<M7PrismStatus> {
  const relevant = records.filter(
    ({ text }) => /M7/i.test(text) && text.includes("棱镜攻势")
  );

  if (relevant.length === 0) {
    return { status: "absent", evidence: [] };
  }

  const statuses = relevant.map(({ text }): M7PrismStatus => {
    const denied =
      text.includes("无棱镜攻势") ||
      text.includes("未拥有棱镜攻势") ||
      text.includes("非极品");
    const peak = text.includes("极品");
    const premium = text.includes("优品");

    if ((peak && denied) || (peak && premium)) {
      return "conflicting";
    }
    if (denied) {
      return "absent";
    }
    if (premium) {
      return "premium";
    }
    if (peak) {
      return "peak";
    }
    return "unknown";
  });

  const unique = new Set(statuses);
  const status =
    unique.has("conflicting") || unique.size > 1
      ? "conflicting"
      : (statuses[0] ?? "unknown");

  return { status, evidence: relevant };
}

export function parseRedSkins(
  records: EvidenceRecord[],
  aliases: readonly string[] = DEFAULT_CHARACTER_ALIASES
): {
  names: string[];
  unnamed: boolean;
  evidence: EvidenceRecord[];
} {
  const evidence = records.filter(
    ({ text }) => text.includes("红皮") || text.includes("红色品质")
  );
  const names = aliases.filter((alias) =>
    evidence.some(
      ({ text }) =>
        text.includes(alias) &&
        (text.includes("红皮") || text.includes("红色品质"))
    )
  );

  return {
    names: [...new Set(names)],
    unnamed: evidence.length > 0 && names.length === 0,
    evidence
  };
}

export function parseJulang(
  records: EvidenceRecord[]
): EvidenceMatch<"unknown" | "absent" | "owned"> & {
  quality?: string;
} {
  const evidence = records.filter(({ text }) => text.includes("巨浪"));
  if (evidence.length === 0) {
    return { status: "unknown", evidence: [] };
  }

  if (
    evidence.some(
      ({ text }) => text.includes("无巨浪") || text.includes("未拥有巨浪")
    )
  ) {
    return { status: "absent", evidence };
  }

  const quality = evidence
    .map(({ text }) => text.match(/(极品|优品|典藏|传说|稀有)/)?.[1])
    .find(Boolean);

  return {
    status: "owned",
    quality,
    evidence
  };
}
