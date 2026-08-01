import type {
  Eligibility,
  LoginPlatform,
  Service
} from "./listing.js";

export interface EligibilityInput {
  loginPlatform: LoginPlatform;
  service: Service;
  priceCny: number | null;
}

export function classifyListing(input: EligibilityInput): Eligibility {
  const knownFailure =
    input.loginPlatform === "wechat" ||
    input.service === "non_official" ||
    (input.priceCny !== null && input.priceCny > 6_000);

  if (knownFailure) {
    return "rejected";
  }

  const allProven =
    input.loginPlatform === "qq" &&
    input.service === "official" &&
    input.priceCny !== null &&
    input.priceCny <= 6_000;

  return allProven ? "eligible" : "needs_verification";
}
