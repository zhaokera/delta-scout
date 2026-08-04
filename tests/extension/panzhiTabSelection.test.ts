import { describe, expect, it, vi } from "vitest";
import {
  selectOrCreatePanzhiTab,
  selectPanzhiTab,
  type PanzhiBrowserTab,
  type PanzhiTabsApi
} from "../../extensions/panzhi-auto-refresh/src/tabSelection.js";

const canonicalUrl = "https://www.pzds.com/goodsList/391/6";

function tab(
  id: number,
  url: string,
  lastAccessed: number
): PanzhiBrowserTab {
  return { id, url, lastAccessed };
}

describe("deterministic Panzhi tab selection", () => {
  it("prefers the canonical URL before path matches, then newest access and smallest ID", () => {
    expect(selectPanzhiTab([
      tab(30, `${canonicalUrl}?from=favorite`, 9_000),
      tab(20, canonicalUrl, 100),
      tab(10, canonicalUrl, 100),
      tab(1, "https://www.pzds.com/goodsDetails/1/6", 99_999)
    ])).toEqual(tab(10, canonicalUrl, 100));

    expect(selectPanzhiTab([
      tab(9, `${canonicalUrl}?from=old`, 100),
      tab(8, `${canonicalUrl}#filters`, 200),
      tab(7, `${canonicalUrl}?from=new`, 200)
    ])).toEqual(tab(7, `${canonicalUrl}?from=new`, 200));
  });

  it("leaves every non-selected tab open", async () => {
    const remove = vi.fn();
    const tabs: PanzhiTabsApi & { remove: typeof remove } = {
      query: vi.fn().mockResolvedValue([
        tab(4, canonicalUrl, 2),
        tab(5, canonicalUrl, 1)
      ]),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      remove
    };

    await expect(selectOrCreatePanzhiTab(tabs)).resolves.toMatchObject({ id: 4 });
    expect(remove).not.toHaveBeenCalled();
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it("creates exactly one canonical tab when no matching candidate exists", async () => {
    const created = tab(12, canonicalUrl, 300);
    const tabs: PanzhiTabsApi = {
      query: vi.fn().mockResolvedValue([
        tab(1, "https://www.pzds.com/goodsDetails/1/6", 500)
      ]),
      create: vi.fn().mockResolvedValue(created),
      get: vi.fn(),
      update: vi.fn()
    };

    await expect(selectOrCreatePanzhiTab(tabs)).resolves.toEqual(created);
    expect(tabs.create).toHaveBeenCalledOnce();
    expect(tabs.create).toHaveBeenCalledWith({ url: canonicalUrl, active: false });
  });
});
