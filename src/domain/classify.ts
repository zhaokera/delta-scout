import type {
  Eligibility,
  LoginPlatform,
  Service
} from "./listing.js";
import type { M7PrismStatus } from "./evidence.js";

export interface EligibilityInput {
  loginPlatform: LoginPlatform;
  service: Service;
  priceCny: number | null;
  m7PrismStatus: M7PrismStatus;
}

export function classifyListing(input: EligibilityInput): Eligibility {
  const knownFailure =
    input.loginPlatform === "wechat" ||
    input.service === "non_official" ||
    (input.priceCny !== null && input.priceCny > 6_000) ||
    input.m7PrismStatus === "absent" ||
    input.m7PrismStatus === "premium";

  if (knownFailure) {
    return "rejected";
  }

  const allProven =
    input.loginPlatform === "qq" &&
    input.service === "official" &&
    input.priceCny !== null &&
    input.priceCny <= 6_000 &&
    input.m7PrismStatus === "peak";

  return allProven ? "eligible" : "needs_verification";
}
