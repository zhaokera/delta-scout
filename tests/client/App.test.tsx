import { render, screen } from "@testing-library/react";
import { App } from "../../src/client/App";

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
});
