import type { M7RareFinish } from "./listing.js";

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
const JYM_TRUNCATED_M7_TARGET =
  /(?<![A-Za-z0-9非])M7战\s*(?:\.{3}|…)\s*势S2(?![A-Za-z0-9])/i;
const MAX_JYM_TRUNCATED_GROUP_LENGTH = 160;

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

export const REQUIRED_RED_SKIN_LABELS = [
  "骇爪-维什戴尔",
  "露娜-黑天际线"
] as const;

export type RequiredRedSkinLabel =
  (typeof REQUIRED_RED_SKIN_LABELS)[number];

export type RequiredRedSkinStatus =
  | "complete"
  | "partial"
  | "missing"
  | "unknown";

const REQUIRED_RED_SKIN_TARGETS = [
  {
    label: REQUIRED_RED_SKIN_LABELS[0],
    characterAliases: ["骇爪", "麦晓雯"],
    skinAliases: ["维什戴尔"]
  },
  {
    label: REQUIRED_RED_SKIN_LABELS[1],
    characterAliases: ["露娜"],
    skinAliases: ["黑天际线"]
  }
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
      M7_PRISM_NEGATED_TARGET.test(text) ||
      findJymTruncatedPeakQualities(text).length > 0
  );

  if (relevant.length === 0) {
    return { status: "unknown", evidence: [], quality: undefined };
  }

  const standardMatches = relevant
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
        quality:
          status === "peak" || status === "premium"
            ? quality
            : undefined
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
  const truncatedMatches = relevant.flatMap(({ text }) =>
    findJymTruncatedPeakQualities(text).map((quality) => ({
      status: "peak" as const,
      quality
    }))
  );
  const matches = [...standardMatches, ...truncatedMatches];

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
  const statusQualities = explicitMatches
    .filter(({ status: candidate }) => candidate === status)
    .map(({ quality: candidate }) => candidate);
  const quality =
    (status === "peak" || status === "premium") &&
    statusQualities.length > 0 &&
    statusQualities.every(
      (candidate) =>
        candidate !== undefined && candidate === statusQualities[0]
    )
      ? statusQualities[0]
      : undefined;

  return { status, evidence: relevant, quality };
}

const M7_RARE_FINISH_PATTERNS = [
  { finish: "pearl", pattern: /珠光/g },
  { finish: "iridescent", pattern: /炫彩/g },
  { finish: "candy", pattern: /糖果(?:纸)?/g }
] as const satisfies ReadonlyArray<{
  finish: M7RareFinish;
  pattern: RegExp;
}>;
const M7_RARE_FINISH_ORDER: readonly M7RareFinish[] = [
  "pearl",
  "iridescent",
  "candy"
];
const M7_SUBJECT_TOKEN = /(?<![A-Za-z0-9])M7(?![A-Za-z0-9])/gi;
const NAMED_OTHER_SUBJECT =
  /巨浪|MP7|AUG|KC17|K416|M250|腾龙|挂饰|3[×xX*]3|(?<!\d)33(?!\d)|收藏品|手办/gi;
const GENERIC_MODEL_SUBJECT =
  /(?<![A-Za-z0-9])(?=[A-Z0-9-]{2,12}(?![A-Za-z0-9]))(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9-]{1,11}(?![A-Za-z0-9])/gi;
const M7_RARE_FINISH_NEGATION = /无|非|不是|不带|没有|未有|不含/;
const MAX_M7_RARE_FINISH_DISTANCE = 24;

interface RareFinishSubject {
  kind: "m7" | "other";
  start: number;
  end: number;
}

function matchRanges(text: string, pattern: RegExp): Array<{
  text: string;
  start: number;
  end: number;
}> {
  return [...text.matchAll(pattern)].flatMap((match) =>
    match.index === undefined
      ? []
      : [
          {
            text: match[0],
            start: match.index,
            end: match.index + match[0].length
          }
        ]
  );
}

function isNonSubjectAttribute(
  text: string,
  start: number,
  end: number,
  token: string
): boolean {
  const normalized = token.toUpperCase();
  if (
    normalized === "S2" &&
    /棱镜攻势\s*$/i.test(text.slice(Math.max(0, start - 16), start))
  ) {
    return true;
  }
  return (
    /^[SABC]?T0$/.test(normalized) &&
    /^\s*模板/i.test(text.slice(end, end + 6))
  );
}

function rareFinishSubjects(text: string): RareFinishSubject[] {
  const subjects: RareFinishSubject[] = matchRanges(
    text,
    M7_SUBJECT_TOKEN
  ).map(({ start, end }) => ({ kind: "m7", start, end }));

  for (const { text: token, start, end } of [
    ...matchRanges(text, NAMED_OTHER_SUBJECT),
    ...matchRanges(text, GENERIC_MODEL_SUBJECT)
  ]) {
    if (token.toUpperCase() === "M7") continue;
    if (isNonSubjectAttribute(text, start, end, token)) continue;
    const existing = subjects.find(
      (subject) => subject.start === start && subject.end === end
    );
    if (existing) {
      if (existing.kind !== "m7") existing.kind = "other";
      continue;
    }
    subjects.push({ kind: "other", start, end });
  }

  return subjects;
}

function visibleDistance(
  text: string,
  left: { start: number; end: number },
  right: { start: number; end: number }
): number {
  const between =
    left.end <= right.start
      ? text.slice(left.end, right.start)
      : right.end <= left.start
        ? text.slice(right.end, left.start)
        : "";
  return [...between].filter((character) => !/\s/u.test(character)).length;
}

function hasRareFinishNegation(
  text: string,
  subject: RareFinishSubject,
  keyword: { start: number; end: number }
): boolean {
  const visiblePrefix = text
    .slice(0, keyword.start)
    .replace(/\s/gu, "")
    .slice(-4);
  const between =
    subject.end <= keyword.start
      ? text.slice(subject.end, keyword.start)
      : text.slice(keyword.end, subject.start);
  return (
    M7_RARE_FINISH_NEGATION.test(visiblePrefix) ||
    M7_RARE_FINISH_NEGATION.test(between)
  );
}

function hasM7QualityBridge(
  text: string,
  subject: RareFinishSubject,
  keyword: { start: number; end: number }
): boolean {
  if (subject.kind !== "m7") return false;
  const between =
    subject.end <= keyword.start
      ? text.slice(subject.end, keyword.start)
      : text.slice(keyword.end, subject.start);
  return /^[\s—–·•・_：:()（）[\]【】-]*(?:极品|优品)?[SABC]?[\s—–·•・_：:()（）[\]【】-]*$/i.test(
    between
  );
}

function parseM7RareFinishesUnsafe(records: EvidenceRecord[]): {
  finishes: M7RareFinish[];
  evidence: EvidenceRecord[];
} {
  const matchedFinishes = new Set<M7RareFinish>();
  const matchedRecords = new Set<EvidenceRecord>();

  for (const record of records) {
    for (const clause of splitEvidenceClauses(record.text)) {
      const subjects = rareFinishSubjects(clause);
      for (const { finish, pattern } of M7_RARE_FINISH_PATTERNS) {
        for (const keyword of matchRanges(clause, pattern)) {
          const candidates = subjects
            .map((subject) => ({
              subject,
              distance: visibleDistance(clause, subject, keyword)
            }))
            .filter(
              ({ distance }) =>
                distance <= MAX_M7_RARE_FINISH_DISTANCE
            )
            .sort((left, right) => left.distance - right.distance);
          const nearest = candidates[0];
          if (!nearest) continue;
          const tied = candidates.filter(
            ({ distance }) => distance === nearest.distance
          );
          const selected =
            tied.length === 1
              ? nearest
              : tied.filter(({ subject }) =>
                  hasM7QualityBridge(clause, subject, keyword)
                ).length === 1
                ? tied.find(({ subject }) =>
                    hasM7QualityBridge(clause, subject, keyword)
                  )
                : undefined;
          if (!selected || selected.subject.kind !== "m7") continue;
          if (
            hasRareFinishNegation(
              clause,
              selected.subject,
              keyword
            )
          ) {
            continue;
          }
          matchedFinishes.add(finish);
          matchedRecords.add(record);
        }
      }
    }
  }

  return {
    finishes: M7_RARE_FINISH_ORDER.filter((finish) =>
      matchedFinishes.has(finish)
    ),
    evidence: records.filter((record) => matchedRecords.has(record))
  };
}

export function parseM7RareFinishes(records: EvidenceRecord[]): {
  finishes: M7RareFinish[];
  evidence: EvidenceRecord[];
} {
  try {
    return parseM7RareFinishesUnsafe(records);
  } catch {
    return { finishes: [], evidence: [] };
  }
}

function findJymTruncatedPeakQualities(
  text: string
): M7PrismQuality[] {
  const groups = [
    ...text.matchAll(/(非极品|极品|优品)\|/g)
  ];
  return groups.flatMap((group, index) => {
    if (group[1] !== "极品" || group.index === undefined) return [];
    const groupHeaderEnd = group.index + group[0].length;
    const count = text
      .slice(groupHeaderEnd)
      .match(/^([SABC])x([1-9]\d*)/i);
    if (!count) return [];
    const contentStart = groupHeaderEnd + count[0].length;
    const nextGroupStart =
      groups[index + 1]?.index ?? text.length;
    const contentEnd = Math.min(
      nextGroupStart,
      contentStart + MAX_JYM_TRUNCATED_GROUP_LENGTH
    );
    const content = text.slice(contentStart, contentEnd);
    const targets = content.matchAll(
      new RegExp(
        JYM_TRUNCATED_M7_TARGET.source,
        `${JYM_TRUNCATED_M7_TARGET.flags}g`
      )
    );
    const hasPositiveTarget = [...targets].some(
      (target) =>
        target.index !== undefined &&
        !/(?:非|无|未拥有)\s*$/.test(
          content.slice(0, target.index)
        )
    );
    return hasPositiveTarget
      ? [count[1].toUpperCase() as M7PrismQuality]
      : [];
  });
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

function requiredSkinMentions(
  text: string,
  characterAliases: readonly string[],
  skinAliases: readonly string[]
): { positive: boolean; negative: boolean } {
  const compact = compactSkinName(text).replace(
    /[【】（）()[\]：:，,、/|]/g,
    ""
  );
  let positive = false;
  let negative = false;
  const negativeWords = ["未拥有", "没有", "缺少", "未有", "不含", "不带", "无"];

  for (const characterAlias of characterAliases) {
    const character = compactSkinName(characterAlias);
    for (const skinAlias of skinAliases) {
      const skin = compactSkinName(skinAlias);
      const target = `${character}${skin}`;
      let offset = compact.indexOf(target);
      while (offset >= 0) {
        const prefix = compact.slice(Math.max(0, offset - 8), offset);
        if (negativeWords.some((word) => prefix.endsWith(word))) {
          negative = true;
        } else {
          positive = true;
        }
        offset = compact.indexOf(target, offset + target.length);
      }

      if (
        negativeWords.some((word) =>
          compact.includes(`${character}${word}${skin}`)
        )
      ) {
        negative = true;
      }
    }
  }

  return { positive, negative };
}

export function parseRequiredRedSkins(
  records: EvidenceRecord[]
): {
  names: RequiredRedSkinLabel[];
  status: RequiredRedSkinStatus;
  evidence: EvidenceRecord[];
} {
  const names: RequiredRedSkinLabel[] = [];
  const evidence: EvidenceRecord[] = [];
  let explicitlyMissing = false;

  for (const target of REQUIRED_RED_SKIN_TARGETS) {
    let targetPositive = false;
    let targetNegative = false;
    for (const record of records) {
      const mentions = requiredSkinMentions(
        record.text,
        target.characterAliases,
        target.skinAliases
      );
      if (mentions.positive || mentions.negative) {
        evidence.push(record);
      }
      targetPositive ||= mentions.positive;
      targetNegative ||= mentions.negative;
    }
    if (targetPositive) names.push(target.label);
    if (targetNegative) explicitlyMissing = true;
  }

  const uniqueEvidence = evidence.filter(
    (record, index, all) =>
      all.findIndex(({ text }) => text === record.text) === index
  );
  const status: RequiredRedSkinStatus = explicitlyMissing
    ? "missing"
    : names.length === REQUIRED_RED_SKIN_TARGETS.length
      ? "complete"
      : names.length > 0
        ? "partial"
        : "unknown";

  return { names, status, evidence: uniqueEvidence };
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
