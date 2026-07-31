import type {
  Eligibility,
  LoginPlatform,
  Service
} from "./listing.js";
import type {
  M7PrismQuality,
  M7PrismStatus
} from "./evidence.js";

export interface EligibilityInput {
  loginPlatform: LoginPlatform;
  service: Service;
  priceCny: number | null;
  m7PrismStatus: M7PrismStatus;
  m7PrismQuality: M7PrismQuality | null;
}

export function classifyListing(input: EligibilityInput): Eligibility {
  const rejectedPremium =
    input.m7PrismStatus === "premium" &&
    input.m7PrismQuality !== null &&
    input.m7PrismQuality !== "S";
  const knownFailure =
    input.loginPlatform === "wechat" ||
    input.service === "non_official" ||
    (input.priceCny !== null && input.priceCny > 6_000) ||
    input.m7PrismStatus === "absent" ||
    rejectedPremium;

  if (knownFailure) {
    return "rejected";
  }

  const allProven =
    input.loginPlatform === "qq" &&
    input.service === "official" &&
    input.priceCny !== null &&
    input.priceCny <= 6_000 &&
    (input.m7PrismStatus === "peak" ||
      (input.m7PrismStatus === "premium" &&
        input.m7PrismQuality === "S"));

  return allProven ? "eligible" : "needs_verification";
}
