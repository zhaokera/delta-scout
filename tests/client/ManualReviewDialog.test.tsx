import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ManualReviewDialog } from "../../src/client/components/ManualReviewDialog";
import type {
  ManualExclusionInput,
  ReviewedListing
} from "../../src/domain/manualReview";
import { makeListing } from "../domain/listingFactory";

function reviewedListing(): ReviewedListing {
  return {
    ...makeListing({
      key: "panzhi:manual-review",
      sourceListingId: "manual-review",
      title: "待人工判断的 M7 账号"
    }),
    manualReview: null
  };
}

function renderDialog(
  overrides: Partial<{
    pending: boolean;
    error: string | null;
    onCancel: () => void;
    onSubmit: (input: ManualExclusionInput) => void | Promise<void>;
  }> = {}
) {
  const props = {
    listing: reviewedListing(),
    pending: false,
    error: null,
    onCancel: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides
  };
  return {
    props,
    ...render(<ManualReviewDialog {...props} />)
  };
}

describe("ManualReviewDialog", () => {
  it("renders an accessible reason and notes form", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", {
      name: "人工淘汰账号"
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("heading", { name: "人工淘汰账号" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "淘汰原因" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(
      screen.getByRole("textbox", { name: "补充说明（选填）" })
    ).toHaveAttribute("maxLength", "500");
    expect(
      screen.getByRole("button", { name: "取消" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认淘汰" })
    ).toBeDisabled();
  });

  it("cancels without submitting", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("requires a trimmed note when the reason is other", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(screen.getByRole("radio", { name: "其他" }));
    await user.type(
      screen.getByRole("textbox", { name: "补充说明（选填）" }),
      "   "
    );
    await user.click(
      screen.getByRole("button", { name: "确认淘汰" })
    );

    expect(
      screen.getByText("选择其他时请填写说明")
    ).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("submits a normalized reason and note once", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderDialog({ onSubmit });

    await user.click(
      screen.getByRole("radio", { name: "价格虚高" })
    );
    await user.type(
      screen.getByRole("textbox", { name: "补充说明（选填）" }),
      "  同价位有更安全的号  "
    );
    await user.click(
      screen.getByRole("button", { name: "确认淘汰" })
    );

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith({
      reason: "price_overvalued",
      note: "同价位有更安全的号"
    });
  });

  it("disables every control while submission is pending", () => {
    renderDialog({ pending: true });

    for (const control of [
      ...screen.getAllByRole("radio"),
      screen.getByRole("textbox", { name: "补充说明（选填）" }),
      screen.getByRole("button", { name: "取消" }),
      screen.getByRole("button", { name: "正在淘汰…" })
    ]) {
      expect(control).toBeDisabled();
    }
  });

  it("keeps the entered decision visible when the server reports an error", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderDialog();
    const note = screen.getByRole("textbox", {
      name: "补充说明（选填）"
    });

    await user.click(
      screen.getByRole("radio", { name: "卖家问题" })
    );
    await user.type(note, "描述前后不一致");

    rerender(
      <ManualReviewDialog
        {...props}
        error="人工淘汰操作失败，请稍后重试"
      />
    );

    expect(
      screen.getByRole("radio", { name: "卖家问题" })
    ).toBeChecked();
    expect(note).toHaveValue("描述前后不一致");
    expect(
      screen.getByRole("alert")
    ).toHaveTextContent("人工淘汰操作失败，请稍后重试");
  });
});
