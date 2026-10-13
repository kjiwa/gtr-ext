import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PROXY_VECTORS = new URL("../../gtr-proxy/test/vectors.json", import.meta.url);
const LOCAL_VECTORS = new URL("./vectors.json", import.meta.url);

describe("vectors", () => {
  it.skipIf(!existsSync(PROXY_VECTORS))("match the proxy copy byte for byte", () => {
    expect(readFileSync(LOCAL_VECTORS).equals(readFileSync(PROXY_VECTORS))).toBe(true);
  });
});
