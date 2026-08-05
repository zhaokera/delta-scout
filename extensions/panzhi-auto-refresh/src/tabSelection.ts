import { PANZHI_CATALOG_URL } from "./contracts.js";

export interface PanzhiBrowserTab {
  id?: number;
  url?: string;
  lastAccessed?: number;
  status?: "loading" | "complete";
}

export interface PanzhiTabsApi {
  query(queryInfo: { url: string }): Promise<PanzhiBrowserTab[]>;
  create(createProperties: {
    url: string;
    active: boolean;
  }): Promise<PanzhiBrowserTab>;
  get(tabId: number): Promise<PanzhiBrowserTab | null>;
  update(
    tabId: number,
    updateProperties: { active?: boolean; url?: string }
  ): Promise<PanzhiBrowserTab | null>;
  reload(tabId: number): Promise<void>;
}

interface RankedTab {
  tab: PanzhiBrowserTab & { id: number; url: string };
  canonical: boolean;
  lastAccessed: number;
}

function rank(tab: PanzhiBrowserTab): RankedTab | null {
  if (tab.id === undefined || tab.url === undefined) return null;
  try {
    const candidate = new URL(tab.url);
    const canonical = new URL(PANZHI_CATALOG_URL);
    if (
      candidate.origin !== canonical.origin ||
      candidate.pathname !== canonical.pathname
    ) {
      return null;
    }
    return {
      tab: { ...tab, id: tab.id, url: tab.url },
      canonical: tab.url === PANZHI_CATALOG_URL,
      lastAccessed: tab.lastAccessed ?? 0
    };
  } catch {
    return null;
  }
}

export function selectPanzhiTab(
  tabs: readonly PanzhiBrowserTab[]
): PanzhiBrowserTab | undefined {
  return tabs
    .map(rank)
    .filter((candidate): candidate is RankedTab => candidate !== null)
    .sort((left, right) =>
      Number(right.canonical) - Number(left.canonical) ||
      right.lastAccessed - left.lastAccessed ||
      left.tab.id - right.tab.id
    )[0]?.tab;
}

export async function selectOrCreatePanzhiTab(
  tabs: PanzhiTabsApi
): Promise<PanzhiBrowserTab & { id: number }> {
  const candidates = await tabs.query({ url: "https://www.pzds.com/*" });
  const selected = selectPanzhiTab(candidates);
  if (selected?.id !== undefined) {
    return { ...selected, id: selected.id };
  }
  const created = await tabs.create({ url: PANZHI_CATALOG_URL, active: false });
  if (created.id === undefined) {
    throw new Error("Chrome did not assign an ID to the Panzhi tab");
  }
  return { ...created, id: created.id };
}
