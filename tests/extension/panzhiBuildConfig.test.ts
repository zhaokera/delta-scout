import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Panzhi extension build wiring", () => {
  it("builds the two MV3 entries from tracked sources", () => {
    const packageJson = JSON.parse(readProjectFile("package.json")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const buildScript = readProjectFile("scripts/build-panzhi-extension.mjs");

    expect(scripts["build:panzhi-extension"]).toBe(
      "node scripts/build-panzhi-extension.mjs"
    );
    expect(scripts.build).toContain("pnpm build:panzhi-extension");
    expect(scripts.typecheck).toContain(
      "tsc -p tsconfig.extension.json --noEmit"
    );
    expect(packageJson.devDependencies?.esbuild).toBeDefined();
    expect(packageJson.devDependencies?.["@types/chrome"]).toBeDefined();
    expect(buildScript).toContain(
      "extensions/panzhi-auto-refresh/src/background.ts"
    );
    expect(buildScript).toContain(
      "extensions/panzhi-auto-refresh/src/content.ts"
    );
    expect(buildScript).toContain("extensions/panzhi-auto-refresh/dist");
    expect(buildScript).toContain("copyFile(");
    expect(buildScript).toContain('resolve(extensionRoot, "manifest.json")');
  });

  it("ignores only the generated extension directory", () => {
    const ignoreLines = readProjectFile(".gitignore")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(ignoreLines).toContain("/extensions/panzhi-auto-refresh/dist/");
    expect(ignoreLines).not.toContain("dist/");
    expect(ignoreLines).not.toContain("extensions/panzhi-auto-refresh/");
  });
});
