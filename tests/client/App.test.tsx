import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { App } from "../../src/client/App";
import type {
  ScoutApi,
  SourceStatusView
} from "../../src/client/api";
import { makeListing } from "../domain/listingFactory";

describe("App shell", () => {
  it("shows the fixed account requirements", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "三角洲账号候选台" })
    ).toBeInTheDocument();
    expect(screen.getByText("QQ 官服")).toBeInTheDocument();
    expect(screen.getByText("M7 棱镜攻势 · 极品")).toBeInTheDocument();
    expect(screen.getByText("¥6,000 以内")).toBeInTheDocument();
  });

  it("loads source states and opens complete candidate evidence", async () => {
    const listing = makeListing({
      key: "panzhi:SA2PEAK",
      sourceListingId: "SA2PEAK",
      priceCny: 5560,
      m7PrismQuality: "A",
      redSkins: ["威龙", "骇爪", "红狼"],
      redSkinCount: 3,
      totalAssetsM: 482,
      hafCoins: 31_880_000,
      julangStatus: "owned",
      julangQuality: "极品",
      recoveryCoverage: false,
      score: {
        total: 87,
        parts: { safety: 32, price: 21, assets: 19, confidence: 15 },
        reasons: ["安全信息 32.0/40", "价格合理性 21.0/25"]
      }
    });
    const api: ScoutApi = {
      getSources: vi.fn(async (): Promise<SourceStatusView[]> => [
        {
          source: "jiaoyimao",
          state: "blocked",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: null,
          itemCount: 0,
          error: "captcha_required",
          stale: false
        },
        {
          source: "panzhi",
          state: "success",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: "2026-07-28T10:00:00.000Z",
          itemCount: 10,
          error: null,
          stale: false
        },
        {
          source: "pxb7",
          state: "blocked",
          lastAttemptAt: "2026-07-28T10:00:00.000Z",
          lastSuccessAt: null,
          itemCount: 0,
          error: "unverified_structure",
          stale: false
        }
      ]),
      getListings: vi.fn(async () => [listing]),
      getListing: vi.fn(async () => listing),
      refresh: vi.fn(async () => undefined)
    };

    render(<App api={api} />);

    expect(await screen.findByText("验证码阻塞")).toBeInTheDocument();
    expect(screen.getByText("列表待人工接入")).toBeInTheDocument();
    const row = screen.getByRole("button", {
      name: /SA2PEAK.*¥5,560/
    });
    expect(within(row).getByText("3 角色红皮")).toBeInTheDocument();
    expect(within(row).getByText("M7 · 极品A")).toBeInTheDocument();
    expect(within(row).getByText("巨浪 · 极品")).toBeInTheDocument();
    expect(within(row).getByText("482M")).toBeInTheDocument();
    expect(within(row).getByText("87")).toBeInTheDocument();

    await userEvent.click(row);
    const detail = await screen.findByRole("complementary", {
      name: "候选详情"
    });
    expect(
      within(detail).getByText("M7 棱镜攻势 · 极品A")
    ).toBeInTheDocument();
    expect(within(detail).getByText("威龙 · 骇爪 · 红狼")).toBeInTheDocument();
    expect(within(detail).getByText("31,880,000")).toBeInTheDocument();
    expect(within(detail).getByText("M7 棱镜攻势 极品")).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: "前往盼之核验" })
    ).toHaveAttribute("target", "_blank");
  });

  it("refreshes and reloads the default eligible view", async () => {
    const api: ScoutApi = {
      getSources: vi.fn(async () => []),
      getListings: vi.fn(async () => []),
      getListing: vi.fn(async () => {
        throw new Error("not used");
      }),
      refresh: vi.fn(async () => undefined)
    };
    render(<App api={api} />);
    const button = await screen.findByRole("button", {
      name: "刷新公开数据"
    });
    await userEvent.click(button);

    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.getListings).toHaveBeenLastCalledWith("eligible");
    expect(api.getSources).toHaveBeenCalledTimes(2);
  });
});
