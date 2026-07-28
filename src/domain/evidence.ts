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

const KNOWN_RED_CHARACTER_SKINS = [
  { character: "威龙", characterAliases: ["威龙"], skinAliases: ["凌霄戍卫"] },
  { character: "露娜", characterAliases: ["露娜"], skinAliases: ["黑天际线"] },
  {
    character: "骇爪",
    characterAliases: ["骇爪", "麦晓雯"],
    skinAliases: ["维什戴尔", "水墨云图"]
  },
  {
    character: "蛊",
    characterAliases: ["蛊"],
    skinAliases: ["能天使午夜邮差"]
  },
  { character: "红狼", characterAliases: ["红狼"], skinAliases: ["蚀金玫瑰"] }
] as const;

function compactSkinName(value: string): string {
  return value.replace(/[\s·•・._—–-]/g, "");
}

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
    ({ text }) => /M7/i.test(text) && text.includes("棱镜")
  );

  if (relevant.length === 0) {
    return { status: "absent", evidence: [] };
  }

  const clauses = relevant.flatMap(({ text }) =>
    splitEvidenceClauses(text).filter(
      (clause) => /M7/i.test(clause) && clause.includes("棱镜")
    )
  );
  const statuses = clauses.map((text): M7PrismStatus => {
    const denied =
      text.includes("无棱镜") ||
      text.includes("未拥有棱镜") ||
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

function splitEvidenceClauses(text: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let parenthesisDepth = 0;

  for (const character of text) {
    if (character === "(" || character === "（") {
      parenthesisDepth += 1;
    } else if (
      (character === ")" || character === "）") &&
      parenthesisDepth > 0
    ) {
      parenthesisDepth -= 1;
    }

    if (
      parenthesisDepth === 0 &&
      ["/", "，", ",", "；", ";", "\n"].includes(character)
    ) {
      if (current.trim()) clauses.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

export function parseRedSkins(
  records: EvidenceRecord[],
  aliases: readonly string[] = DEFAULT_CHARACTER_ALIASES
): {
  names: string[];
  unnamed: boolean;
  evidence: EvidenceRecord[];
} {
  const explicitEvidence = records.filter(
    ({ text }) => text.includes("红皮") || text.includes("红色品质")
  );
  const knownMatches = KNOWN_RED_CHARACTER_SKINS.filter((entry) =>
    records.some(({ text }) => {
      const compact = compactSkinName(text);
      return (
        entry.characterAliases.some((alias) => compact.includes(alias)) &&
        entry.skinAliases.some((skin) =>
          compact.includes(compactSkinName(skin))
        )
      );
    })
  );
  const knownEvidence = records.filter(({ text }) => {
    const compact = compactSkinName(text);
    return knownMatches.some(
      (entry) =>
        entry.characterAliases.some((alias) => compact.includes(alias)) &&
        entry.skinAliases.some((skin) =>
          compact.includes(compactSkinName(skin))
        )
    );
  });
  const evidence = [...explicitEvidence, ...knownEvidence].filter(
    (record, index, all) =>
      all.findIndex(({ text }) => text === record.text) === index
  );
  const explicitlyNamed = aliases.filter((alias) =>
    explicitEvidence.some(
      ({ text }) =>
        text.includes(alias) &&
        (text.includes("红皮") || text.includes("红色品质"))
    )
  );
  const names = [
    ...explicitlyNamed,
    ...knownMatches.map(({ character }) => character)
  ];

  return {
    names: [...new Set(names)],
    unnamed: explicitEvidence.length > 0 && names.length === 0,
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
