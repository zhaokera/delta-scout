import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Panzhi extension manifest", () => {
  it("tracks the exact least-privilege MV3 allowlist and planned entry points", () => {
    const manifest = JSON.parse(readFileSync(resolve(
      process.cwd(),
      "extensions/panzhi-auto-refresh/manifest.json"
    ), "utf8")) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(3);
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
      service_worker: "background.js",
      type: "module"
    });
    expect(manifest.content_scripts).toEqual([{
      matches: ["https://www.pzds.com/*"],
      js: ["content.js"],
      run_at: "document_idle"
    }]);
    expect(JSON.stringify(manifest)).not.toMatch(
      /cookies|webRequest|history|downloads|clipboard|<all_urls>/i
    );
  });
});
