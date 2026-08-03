import type {
  Eligibility,
  LoginPlatform,
  Service
} from "./listing.js";
import type { RequiredRedSkinStatus } from "./evidence.js";
import { isCandidatePriceCny } from "./priceRange.js";

export interface EligibilityInput {
  loginPlatform: LoginPlatform;
  service: Service;
  priceCny: number | null;
  requiredRedSkinStatus: RequiredRedSkinStatus;
  secondRealNameAvailable: boolean | null;
}

export function classifyListing(input: EligibilityInput): Eligibility {
  const knownFailure =
    input.loginPlatform === "wechat" ||
    input.service === "non_official" ||
    input.requiredRedSkinStatus === "missing" ||
    input.secondRealNameAvailable === false ||
    (input.priceCny !== null && !isCandidatePriceCny(input.priceCny));

  if (knownFailure) {
    return "rejected";
  }

  const allProven =
    input.loginPlatform === "qq" &&
    input.service === "official" &&
    input.requiredRedSkinStatus === "complete" &&
    input.secondRealNameAvailable === true &&
    input.priceCny !== null &&
    isCandidatePriceCny(input.priceCny);

  return allProven ? "eligible" : "needs_verification";
}
