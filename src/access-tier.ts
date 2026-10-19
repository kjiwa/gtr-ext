export const ACCESS_TIERS = ["Hot", "Cool", "Archive"] as const;

export type AccessTier = (typeof ACCESS_TIERS)[number];

export function parseAccessTier(value: unknown): AccessTier | "" {
  return ACCESS_TIERS.find((tier) => tier === value) ?? "";
}
