import type { Listing } from "./listing.js";

export const RED_SKIN_VALUE_CNY_PER_POINT = 50;
export const DEFAULT_PAID_RED_SKIN_VALUE_CNY = 250;
export const PREMIUM_PAID_RED_SKIN_VALUE_CNY = 300;

const PAID_RED_SKINS = [
  {
    label: "露娜-黑天际线",
    character: "露娜",
    characterAliases: ["露娜"],
    skinAliases: ["黑天际线"],
    valueCny: PREMIUM_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "骇爪-维什戴尔",
    character: "骇爪",
    characterAliases: ["骇爪", "麦晓雯"],
    skinAliases: ["维什戴尔"],
    valueCny: PREMIUM_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "骇爪-水墨云图",
    character: "骇爪",
    characterAliases: ["骇爪", "麦晓雯"],
    skinAliases: ["水墨云图"],
    valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "威龙-凌霄戍卫",
    character: "威龙",
    characterAliases: ["威龙"],
    skinAliases: ["凌霄戍卫"],
    valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "蛊-能天使·午夜邮差",
    character: "蛊",
    characterAliases: ["蛊"],
    skinAliases: ["能天使午夜邮差"],
    valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "红狼-蚀金玫瑰",
    character: "红狼",
    characterAliases: ["红狼"],
    skinAliases: ["蚀金玫瑰"],
    valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY
  },
  {
    label: "乌鲁鲁-狂怒",
    character: "乌鲁鲁",
    characterAliases: ["乌鲁鲁"],
    skinAliases: ["狂怒"],
    valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY
  }
] as const;

export interface RedSkinValueItem {
  label: string;
  character: string;
  valueCny: number;
  exactSkin: boolean;
}

export interface RedSkinValuation {
  items: RedSkinValueItem[];
  estimatedCny: number;
}

function compact(value: string): string {
  return value.replace(/[\s·•・._—–-]/g, "");
}

function hasPositiveExactMention(
  evidence: Listing["evidence"],
  target: (typeof PAID_RED_SKINS)[number]
): boolean {
  const negativeWords = ["未拥有", "没有", "缺少", "未有", "不含", "不带", "无"];

  return evidence.some(({ text }) => {
    const normalized = compact(text);
    return target.characterAliases.some((characterAlias) =>
      target.skinAliases.some((skinAlias) => {
        const character = compact(characterAlias);
        const skin = compact(skinAlias);
        const adjacentTarget = `${character}${skin}`;
        let offset = normalized.indexOf(adjacentTarget);
        while (offset >= 0) {
          const prefix = normalized.slice(Math.max(0, offset - 8), offset);
          if (!negativeWords.some((word) => prefix.endsWith(word))) {
            return true;
          }
          offset = normalized.indexOf(adjacentTarget, offset + adjacentTarget.length);
        }

        let characterOffset = normalized.indexOf(character);
        while (characterOffset >= 0) {
          const skinOffset = normalized.indexOf(
            skin,
            characterOffset + character.length
          );
          if (skinOffset >= 0 && skinOffset - characterOffset <= 20) {
            const mention = normalized.slice(
              Math.max(0, characterOffset - 8),
              skinOffset
            );
            if (!negativeWords.some((word) => mention.includes(word))) {
              return true;
            }
          }
          characterOffset = normalized.indexOf(
            character,
            characterOffset + character.length
          );
        }
        return false;
      })
    );
  });
}

export function redSkinValuation(
  listing: Pick<Listing, "evidence" | "redSkins" | "requiredRedSkins">
): RedSkinValuation {
  const itemsByLabel = new Map<string, RedSkinValueItem>();

  for (const skin of PAID_RED_SKINS) {
    if (hasPositiveExactMention(listing.evidence, skin)) {
      itemsByLabel.set(skin.label, {
        label: skin.label,
        character: skin.character,
        valueCny: skin.valueCny,
        exactSkin: true
      });
    }
  }

  for (const requiredLabel of listing.requiredRedSkins) {
    const skin = PAID_RED_SKINS.find(({ label }) => label === requiredLabel);
    if (skin) {
      itemsByLabel.set(skin.label, {
        label: skin.label,
        character: skin.character,
        valueCny: skin.valueCny,
        exactSkin: true
      });
    }
  }

  const exactCharacters = new Set(
    [...itemsByLabel.values()].map(({ character }) => character)
  );
  for (const character of new Set(listing.redSkins)) {
    if (exactCharacters.has(character)) continue;
    itemsByLabel.set(`${character}-红皮`, {
      label: `${character}-红皮（具体款式待核验）`,
      character,
      valueCny: DEFAULT_PAID_RED_SKIN_VALUE_CNY,
      exactSkin: false
    });
  }

  const items = [...itemsByLabel.values()];
  return {
    items,
    estimatedCny: items.reduce((sum, item) => sum + item.valueCny, 0)
  };
}
