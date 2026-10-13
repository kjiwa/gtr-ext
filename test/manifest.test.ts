import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import vectors from "./vectors.json";

const manifest = JSON.parse(readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8")) as { host_permissions?: string[] };

function matchesPattern(pattern: string, url: URL): boolean {
  const [scheme, rest] = pattern.split("://") as [string, string];
  const host = rest.slice(0, rest.indexOf("/"));
  const hostMatches = host.startsWith("*.") ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host;
  return `${url.protocol}` === `${scheme}:` && hostMatches;
}

describe("manifest", () => {
  it.each(vectors.takeoutUrls.accept)("grants cookie access to %s", (url) => {
    const target = new URL(url);
    expect((manifest.host_permissions ?? []).some((pattern) => matchesPattern(pattern, target))).toBe(true);
  });
});
