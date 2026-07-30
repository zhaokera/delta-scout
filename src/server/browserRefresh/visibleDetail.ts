import { toEvidenceRecords } from "../../domain/evidence.js";
import type {
  DetailParseResult,
  ListingSummary
} from "../collector/types.js";
import {
  compactText,
  parseChineseAmount
} from "../collector/adapters/shared.js";

export interface JiaoyimaoVisibleSections {
  head: string;
  report: string;
  safety: string;
  description: string;
}

const MAX_STORED_EVIDENCE_CHARS = 2_000;
const STORED_EVIDENCE_SUFFIX_CHARS =
  Math.floor(MAX_STORED_EVIDENCE_CHARS / 2);
const STORED_EVIDENCE_PREFIX_CHARS =
  MAX_STORED_EVIDENCE_CHARS - STORED_EVIDENCE_SUFFIX_CHARS - 1;

function toBoundedEvidenceRecords(lines: string[]) {
  return lines.flatMap((line) => {
    const record = toEvidenceRecords([line])[0];
    if (!record || !record.truncated) return record ? [record] : [];

    const characters = [...line.trim()];
    return [{
      text: [
        ...characters.slice(0, STORED_EVIDENCE_PREFIX_CHARS),
        "…",
        ...characters.slice(-STORED_EVIDENCE_SUFFIX_CHARS)
      ].join(""),
      truncated: true
    }];
  });
}

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseVerificationAt(text: string): string | null {
  const match = text.match(
    /验号时间[：:\s]*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/
  );
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseJiaoyimaoVisibleDetail(
  sections: JiaoyimaoVisibleSections,
  _summary: ListingSummary
): DetailParseResult {
  const head = compactText(sections.head);
  const report = compactText(sections.report);
  const safety = compactText(sections.safety);
  const description = compactText(sections.description);
  if (!head || !report) {
    return { kind: "blocked", reason: "structure_changed" };
  }

  const fullSections = [
    ...new Set([head, report, safety, description].filter(Boolean))
  ];
  const evidence = toBoundedEvidenceRecords(fullSections);
  const currentProductText = fullSections.join("\n");
  const totalAssetsRaw = parseChineseAmount(
    currentProductText,
    "总资产"
  );
  const totalAssetsM =
    totalAssetsRaw === null ? null : totalAssetsRaw / 1_000_000;
  const hafCoinsMatch = currentProductText.match(
    /哈夫币(?:数量)?[】:\s]*([\d,.]+)/
  );
  const loginPlatform = /QQ双端帐号|安卓QQ/.test(head)
    ? "qq"
    : /微信双端帐号|安卓微信/.test(head)
      ? "wechat"
      : "unknown";
  const cannotSecond = /不可二次实名/.test(currentProductText);
  const canSecond =
    !cannotSecond && /(?:是否可二次实名)?可二次实名/.test(currentProductText);
  const noCoverage = /不支持永久包赔|无包赔/.test(currentProductText);
  const hasCoverage = !noCoverage && /永久包赔/.test(currentProductText);
  const hasBanWarning =
    /黑号校验(?:未通过|异常)|(?:存在|有)封号记录/.test(
      currentProductText
    );

  return {
    kind: "ok",
    detail: {
      evidence,
      loginPlatform,
      service: loginPlatform === "qq" ? "official" : "unknown",
      totalAssetsM,
      hafCoins: parseNumber(hafCoinsMatch?.[1]),
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
      verificationAt: parseVerificationAt(currentProductText),
      banNotes: hasBanWarning ? ["页面提示存在封号或黑号风险"] : []
    }
  };
}
