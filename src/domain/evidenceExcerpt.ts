export interface EvidenceExcerptSegment {
  text: string;
  highlighted: boolean;
}

export interface EvidenceExcerpt {
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
  segments: EvidenceExcerptSegment[];
}

const EVIDENCE_KEYWORD =
  /(?:M7|极品|品质)[\s·|:/-]{0,6}[SABC](?:级|档|品质)?|M7|棱镜攻势|极品|珠光|炫彩|糖果纸?/giu;

function keywordMatches(text: string): Array<{
  index: number;
  text: string;
}> {
  return [...text.matchAll(EVIDENCE_KEYWORD)].map((match) => ({
    index: match.index,
    text: match[0]
  }));
}

export function buildEvidenceExcerpt(
  text: string,
  maxLength = 180
): EvidenceExcerpt {
  if (text.length === 0) {
    return {
      leadingEllipsis: false,
      trailingEllipsis: false,
      segments: []
    };
  }

  const limit = Math.max(1, Math.floor(maxLength));
  const firstMatch = keywordMatches(text)[0];
  let start = 0;

  if (text.length > limit && firstMatch) {
    const matchCenter =
      firstMatch.index + Math.floor(firstMatch.text.length / 2);
    start = Math.max(0, matchCenter - Math.floor(limit / 2));
    start = Math.min(start, text.length - limit);
  }

  const end = Math.min(text.length, start + limit);
  const excerpt = text.slice(start, end);
  const matches = keywordMatches(excerpt);
  const segments: EvidenceExcerptSegment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.index > cursor) {
      segments.push({
        text: excerpt.slice(cursor, match.index),
        highlighted: false
      });
    }
    segments.push({ text: match.text, highlighted: true });
    cursor = match.index + match.text.length;
  }

  if (cursor < excerpt.length) {
    segments.push({
      text: excerpt.slice(cursor),
      highlighted: false
    });
  }

  return {
    leadingEllipsis: start > 0,
    trailingEllipsis: end < text.length,
    segments
  };
}
