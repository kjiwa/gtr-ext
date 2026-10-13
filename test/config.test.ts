import { describe, expect, it } from "vitest";
import { generateSecret, isReady, loadConfig, saveConfig, validateConfig, type Config } from "../src/config";
import { fakeExt } from "./fake-ext";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const GOOD: Config = { enabled: true, proxyBase: "https://proxy.example.com", secret: "s3cret", sasUrl: "https://gtrtest.blob.core.windows.net/takeouts?sp=racw&se=2026-01-02T00%3A00%3A00Z&sig=SIG%3D" };

describe("loadConfig and saveConfig", () => {
  it("defaults to disabled with empty fields", async () => {
    expect(await loadConfig(fakeExt().api)).toEqual({ enabled: false, proxyBase: "", secret: "", sasUrl: "" });
  });

  it("round-trips a partial save without disturbing other keys", async () => {
    const { api } = fakeExt();
    await saveConfig(GOOD, api);
    await saveConfig({ enabled: false }, api);
    expect(await loadConfig(api)).toEqual({ ...GOOD, enabled: false });
  });

  it("ignores stored values of the wrong type", async () => {
    const { api } = fakeExt({ enabled: "yes", proxyBase: 5 });
    expect(await loadConfig(api)).toEqual({ enabled: false, proxyBase: "", secret: "", sasUrl: "" });
  });
});

describe("validateConfig", () => {
  it("accepts a complete config", () => {
    expect(validateConfig(GOOD, NOW)).toEqual({});
    expect(isReady(GOOD, NOW)).toBe(true);
  });

  it("reports every empty field", () => {
    const problems = validateConfig({ enabled: true, proxyBase: "", secret: "", sasUrl: "" }, NOW);
    expect(Object.keys(problems).sort()).toEqual(["proxyBase", "sasUrl", "secret"]);
  });

  it("explains a bad proxy URL in a full sentence", () => {
    expect(validateConfig({ ...GOOD, proxyBase: "http://proxy.example.com" }, NOW).proxyBase).toBe("Proxy URL must use https.");
  });

  it("explains an expired SAS", () => {
    expect(validateConfig(GOOD, Date.parse("2026-02-01T00:00:00Z")).sasUrl).toMatch(/expired/);
  });

  it("explains a non-container SAS", () => {
    expect(validateConfig({ ...GOOD, sasUrl: "https://gtrtest.blob.core.windows.net/c/blob.zip?sig=x" }, NOW).sasUrl).toMatch(/container-level/);
  });

  it("is not ready when any field has a problem", () => {
    expect(isReady({ ...GOOD, secret: "" }, NOW)).toBe(false);
  });
});

describe("generateSecret", () => {
  it("returns 32 random bytes as unpadded base64url", () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(secret);
  });
});
