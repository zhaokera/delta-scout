import type { SourceId } from "./listing.js";

const TRACKING_PARAMETERS = new Set(["spm", "from"]);

export function normalizeListingUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || TRACKING_PARAMETERS.has(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

export function listingKey(
  source: SourceId,
  sourceListingId: string | null,
  url: string
): string {
  return `${source}:${sourceListingId ?? normalizeListingUrl(url)}`;
}
