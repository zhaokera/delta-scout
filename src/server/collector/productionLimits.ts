export const PRODUCTION_COLLECTION_LIMITS_BY_SOURCE = {
  jiaoyimao: {
    maxPages: 650,
    maxSummaries: 10_100,
    // Jiaoyimao list cards do not prove all eligibility fields. Keep the
    // detail ceiling aligned with the catalog ceiling so a valid full scan
    // cannot be forced into an endless partial-refresh loop.
    maxDetails: 10_100
  },
  pxb7: {
    maxPages: 650,
    maxSummaries: 10_100,
    maxDetails: 10_100
  }
} as const;
