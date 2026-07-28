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

export type M7PrismQuality = "S" | "A" | "B" | "C";

export interface EvidenceMatch<TStatus extends string> {
  status: TStatus;
  evidence: EvidenceRecord[];
}

const MAX_EVIDENCE_LENGTH = 2_000;
const M7_PRISM_TARGET =
  /(?<![A-Za-z0-9非])M7\s*(?:战斗步枪\s*)?[-—–·•・_：:]?\s*棱镜攻势(?:\s*S2)?/i;
const M7_PRISM_NEGATED_TARGET =
  /(?<![A-Za-z0-9非])M7\s*(?:战斗步枪\s*)?[-—–·•・_：:]?\s*(?:无|未拥有)\s*棱镜攻势(?:\s*S2)?/i;
const ADJACENT_M7_QUALITY =
  /^\s*(?:[：:]\s*)?(?:[（(【]\s*)?(非极品|极品|优品)\s*([SABC])?/i;

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
  { character: "红狼", characterAliases: ["红狼"], skinAliases: ["蚀金玫瑰"] },
  { character: "乌鲁鲁", characterAliases: ["乌鲁鲁"], skinAliases: ["狂怒"] }
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
): EvidenceMatch<M7PrismStatus> & {
  quality?: M7PrismQuality;
} {
  const relevant = records.filter(
    ({ text }) =>
      M7_PRISM_TARGET.test(text) ||
      M7_PRISM_NEGATED_TARGET.test(text)
  );

  if (relevant.length === 0) {
    return { status: "absent", evidence: [], quality: undefined };
  }

  const matches = relevant
    .flatMap(({ text }) => splitEvidenceClauses(text))
    .map((text) => {
      const negatedTarget = text.match(M7_PRISM_NEGATED_TARGET);
      const target = negatedTarget ?? text.match(M7_PRISM_TARGET);
      if (!target || target.index === undefined) return null;

      const suffix = text.slice(target.index + target[0].length);
      const qualityMatch = suffix.match(ADJACENT_M7_QUALITY);
      const qualityWord = qualityMatch?.[1] ?? null;
      const quality = qualityMatch?.[2]?.toUpperCase() as
        | M7PrismQuality
        | undefined;
      const denied =
        negatedTarget !== null ||
        /(?:非|无|未拥有)\s*$/.test(text.slice(0, target.index)) ||
        qualityWord === "非极品";
      const immediateRegion = suffix.slice(0, 24);
      const peak = qualityWord === "极品";
      const premium =
        qualityWord === "优品" ||
        (peak && immediateRegion.includes("优品"));

      let status: M7PrismStatus = "unknown";
      if ((peak && denied) || (peak && premium)) {
        status = "conflicting";
      } else if (denied) {
        status = "absent";
      } else if (premium) {
        status = "premium";
      } else if (peak) {
        status = "peak";
      }

      return {
        status,
        quality: status === "peak" ? quality : undefined
      };
    })
    .filter(
      (
        match
      ): match is {
        status: M7PrismStatus;
        quality: M7PrismQuality | undefined;
      } => match !== null
    );

  const explicitMatches = matches.filter(
    ({ status: candidate }) => candidate !== "unknown"
  );
  const unique = new Set(
    explicitMatches.map(({ status: candidate }) => candidate)
  );
  const status =
    unique.has("conflicting") || unique.size > 1
      ? "conflicting"
      : (explicitMatches[0]?.status ?? "unknown");
  const peakQualities = explicitMatches
    .filter(({ status: candidate }) => candidate === "peak")
    .map(({ quality: candidate }) => candidate);
  const quality =
    status === "peak" &&
    peakQualities.length > 0 &&
    peakQualities.every(
      (candidate) =>
        candidate !== undefined && candidate === peakQualities[0]
    )
      ? peakQualities[0]
      : undefined;

  return { status, evidence: relevant, quality };
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
