import { describe, expect, it } from "vitest";
import { parseContainerSas, SasError, type SasErrorCode } from "../src/sas";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const VALID = "https://gtrtest.blob.core.windows.net/takeouts?sp=racw&se=2026-01-02T00%3A00%3A00Z&sig=abc%3D";

function codeOf(url: string): SasErrorCode | undefined {
  try {
    parseContainerSas(url, NOW);
  } catch (error) {
    return error instanceof SasError ? error.code : undefined;
  }
  return undefined;
}

describe("parseContainerSas", () => {
  it("parses account, container, expiry and permissions", () => {
    expect(parseContainerSas(VALID, NOW)).toEqual({ account: "gtrtest", container: "takeouts", expiresAt: Date.parse("2026-01-02T00:00:00Z"), permissions: "racw" });
  });

  it("accepts a trailing slash, write-only and create-only permissions, and no expiry", () => {
    expect(codeOf("https://gtrtest.blob.core.windows.net/takeouts/?sp=w&sig=x")).toBeUndefined();
    expect(codeOf("https://gtrtest.blob.core.windows.net/takeouts?sp=c&sig=x")).toBeUndefined();
    expect(parseContainerSas("https://gtrtest.blob.core.windows.net/takeouts?sig=x", NOW)).toEqual({ account: "gtrtest", container: "takeouts" });
  });

  it.each([
    ["not a url", "invalid_url"],
    ["http://gtrtest.blob.core.windows.net/takeouts?sp=w&sig=x", "not_https"],
    ["https://gtrtest.example.com/takeouts?sp=w&sig=x", "bad_host"],
    ["https://blob.core.windows.net/takeouts?sp=w&sig=x", "bad_host"],
    ["https://gtrtest.blob.core.windows.net/takeouts/file.zip?sp=w&sig=x", "not_container"],
    ["https://gtrtest.blob.core.windows.net/?sp=w&sig=x", "not_container"],
    ["https://gtrtest.blob.core.windows.net/takeouts?sp=w", "missing_signature"],
    ["https://gtrtest.blob.core.windows.net/takeouts?sp=rl&sig=x", "missing_permissions"],
    ["https://gtrtest.blob.core.windows.net/takeouts?sp=w&se=2025-12-31T00%3A00%3A00Z&sig=x", "expired"],
    ["https://gtrtest.blob.core.windows.net/takeouts?sp=w&se=garbage&sig=x", "invalid_url"],
  ] as const)("rejects %s", (url, code) => {
    expect(codeOf(url)).toBe(code);
  });

  it("gives human-readable messages without the signature", () => {
    expect(() => parseContainerSas("https://gtrtest.blob.core.windows.net/takeouts?sp=r&sig=SECRET", NOW)).toThrow(/write \(w\) or create \(c\)/);
    try {
      parseContainerSas("https://gtrtest.blob.core.windows.net/takeouts?sp=r&sig=SECRET", NOW);
    } catch (error) {
      expect((error as Error).message).not.toContain("SECRET");
    }
  });
});
