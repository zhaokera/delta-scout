import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Panzhi extension manifest", () => {
  it("keeps the repository-root unpacked extension loadable", () => {
    const extensionRoot = resolve(
      process.cwd(),
      "extensions/panzhi-auto-refresh"
    );
    const manifest = JSON.parse(readFileSync(resolve(
      extensionRoot,
      "manifest.json"
    ), "utf8")) as {
      background?: { service_worker?: string };
      content_scripts?: Array<{ js?: string[] }>;
    };
    const referencedFiles = [
      manifest.background?.service_worker,
      ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])
    ].filter((path): path is string => typeof path === "string");

    expect(referencedFiles).not.toEqual([]);
    expect(referencedFiles.filter((path) =>
      !existsSync(resolve(extensionRoot, path))
    )).toEqual([]);
  });

  it("tracks the exact least-privilege MV3 allowlist and planned entry points", () => {
    const manifest = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "extensions/panzhi-auto-refresh/manifest.json"
    ), "utf8")) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe("0.2.2");
    expect(manifest.permissions).toEqual([
      "alarms",
      "tabs",
      "scripting",
      "storage",
      "notifications"
    ]);
    expect(manifest.host_permissions).toEqual([
      "https://www.pzds.com/*",
      "http://127.0.0.1:4310/*"
    ]);
    expect(manifest.background).toEqual({
      service_worker: "dist/background.js",
      type: "module"
    });
    expect(manifest.content_scripts).toEqual([{
      matches: ["https://www.pzds.com/*"],
      js: ["dist/content.js"],
      run_at: "document_idle"
    }]);
    expect(JSON.stringify(manifest)).not.toMatch(
      /cookies|webRequest|history|downloads|clipboard|<all_urls>/i
    );
  });

  it("keeps the extension strict project in the root typecheck command", () => {
    const packageJson = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "package.json"
    ), "utf8")) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.typecheck).toContain(
      "tsc -p tsconfig.extension.json --noEmit"
    );
  });
});
