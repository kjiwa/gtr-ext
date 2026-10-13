import { describe, expect, it } from "vitest";
import { describeConnectionResult, proxyOriginPattern, testConnection } from "../src/ui/connection";
import { formatBytes, formatSpeed } from "../src/ui/format";
import { sasExpiryNotice } from "../src/ui/sas-notice";
import { firstProblem } from "../src/ui/setup";
import { hasFinished, phaseLabel, progressFraction, sortTransfers, toTransferView } from "../src/ui/transfers-view";
import type { Transfer } from "../src/transfers";

const NOW = Date.parse("2026-01-01T00:00:00Z");

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return { id: "a", name: "a.zip", phase: "copying", bytesDone: 0, bytesTotal: 0, startedAt: NOW, ...overrides };
}

describe("format", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.0 KiB"],
    [5 * 1024 ** 3, "5.0 GiB"],
  ])("formats %i bytes", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("formats speed", () => {
    expect(formatSpeed(1536 * 1024)).toBe("1.5 MiB/s");
  });
});

describe("transfers view", () => {
  it("names every phase in words", () => {
    expect(phaseLabel("copying")).toBe("Copying to Azure");
    expect(phaseLabel("interrupted")).toBe("Interrupted");
  });

  it("computes a clamped fraction, indeterminate without a total", () => {
    expect(progressFraction(transfer({ bytesDone: 40, bytesTotal: 100 }))).toBe(0.4);
    expect(progressFraction(transfer({ bytesDone: 200, bytesTotal: 100 }))).toBe(1);
    expect(progressFraction(transfer())).toBeUndefined();
    expect(progressFraction(transfer({ phase: "done", bytesTotal: 5 }))).toBe(1);
  });

  it("sorts newest first without mutating the input", () => {
    const input = [transfer({ id: "old", startedAt: 1 }), transfer({ id: "new", startedAt: 9 })];
    expect(sortTransfers(input).map((item) => item.id)).toEqual(["new", "old"]);
    expect(input[0]?.id).toBe("old");
  });

  it("detects finished transfers only when one is terminal", () => {
    expect(hasFinished([transfer()])).toBe(false);
    expect(hasFinished([transfer(), transfer({ phase: "failed" })])).toBe(true);
  });

  it("shows size, speed and percent while copying", () => {
    const view = toTransferView(transfer({ bytesDone: 2 * 1024 ** 3, bytesTotal: 5 * 1024 ** 3, startedAt: NOW - 10_000 }), NOW);
    expect(view).toMatchObject({ percent: 40, sizeText: "2.0 GiB of 5.0 GiB", speedText: "204.8 MiB/s", cancellable: true, errorText: undefined });
  });

  it("shows no speed outside copying and no cancel for finished transfers", () => {
    const view = toTransferView(transfer({ phase: "done", bytesDone: 10, bytesTotal: 10 }), NOW + 5000);
    expect(view).toMatchObject({ percent: 100, speedText: undefined, cancellable: false, sizeText: "10 B" });
  });

  it("shows the stored error message once for failed and interrupted transfers", () => {
    const failed = toTransferView(transfer({ phase: "failed", error: { code: "proxy_rejected", message: "The proxy rejected the secret." } }), NOW);
    expect(failed.errorText).toBe("The proxy rejected the secret.");
    const interrupted = toTransferView(transfer({ phase: "interrupted", error: { code: "interrupted", message: "Restarted." } }), NOW);
    expect(interrupted.errorText).toBe("Restarted.");
    expect(toTransferView(transfer({ phase: "cancelled" }), NOW).errorText).toBeUndefined();
  });
});

describe("firstProblem", () => {
  it("reports proxy, then secret, then SAS", () => {
    expect(firstProblem({ sasUrl: "c", secret: "b", proxyBase: "a" })).toBe("a");
    expect(firstProblem({ sasUrl: "c", secret: "b" })).toBe("b");
    expect(firstProblem({})).toBeUndefined();
  });
});

describe("sasExpiryNotice", () => {
  const sas = (expiry: string): string => `https://acct.blob.core.windows.net/box?sp=racw&se=${encodeURIComponent(expiry)}&sig=SIG`;

  it("is silent for an empty value", () => {
    expect(sasExpiryNotice("  ", NOW)).toBeUndefined();
  });

  it("shows the local expiry date for a healthy SAS", () => {
    const notice = sasExpiryNotice(sas("2026-03-01T12:00:00Z"), NOW);
    expect(notice?.level).toBe("ok");
    expect(notice?.text).toContain("2026");
  });

  it("warns within 24 hours", () => {
    expect(sasExpiryNotice(sas("2026-01-01T23:00:00Z"), NOW)?.level).toBe("warn");
  });

  it("reports expired and malformed URLs as danger", () => {
    expect(sasExpiryNotice(sas("2025-12-31T00:00:00Z"), NOW)).toMatchObject({ level: "danger", text: expect.stringContaining("expired") });
    expect(sasExpiryNotice("nope", NOW)?.level).toBe("danger");
  });

  it("accepts a SAS without expiry", () => {
    expect(sasExpiryNotice("https://acct.blob.core.windows.net/box?sp=w&sig=SIG", NOW)?.level).toBe("ok");
  });
});

describe("describeConnectionResult", () => {
  it("reports the version on success", () => {
    expect(describeConnectionResult({ kind: "response", status: 200, body: '{"version":"3.0.0"}' })).toEqual({ level: "ok", text: "Connected. Proxy version 3.0.0." });
  });

  it.each([
    [401, "secret"],
    [503, "GTR_SECRET"],
    [404, "HTTP 404"],
  ])("explains HTTP %i", (status, fragment) => {
    const result = describeConnectionResult({ kind: "response", status, body: "" });
    expect(result.level).toBe("danger");
    expect(result.text).toContain(fragment);
  });

  it("flags non-JSON and versionless 200 responses", () => {
    expect(describeConnectionResult({ kind: "response", status: 200, body: "<html></html>" }).text).toContain("not like a GTR proxy");
    expect(describeConnectionResult({ kind: "response", status: 200, body: "{}" }).level).toBe("danger");
  });

  it("explains network failures", () => {
    expect(describeConnectionResult({ kind: "network" }).text).toContain("Could not reach");
  });
});

describe("testConnection", () => {
  it("sends the secret as a bearer token to /health", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"version":"3.0.0"}', { status: 200 });
    }) as unknown as typeof fetch;
    const result = await testConnection("https://p.example.com/", "s3cret", fetchFn);
    expect(result.level).toBe("ok");
    expect(calls[0]?.url).toBe("https://p.example.com/health");
    expect(calls[0]?.init?.headers).toEqual({ Authorization: "Bearer s3cret" });
  });

  it("maps a thrown fetch to a network failure", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fail");
    }) as unknown as typeof fetch;
    expect((await testConnection("https://p.example.com", "x", fetchFn)).text).toContain("Could not reach");
  });
});

describe("proxyOriginPattern", () => {
  it("covers the origin only", () => {
    expect(proxyOriginPattern("https://p.example.com/base/")).toBe("https://p.example.com/*");
  });
});
