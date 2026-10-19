import { describe, expect, it } from "vitest";
import { buildRelayUrl } from "../src/protocol/azure";
import { commitBlockList, planBlocks, probe, stageBlock, transload, TransloadError, type Block, type Target, type TransloadErrorCode } from "../src/transload";
import type { FetchFn } from "../src/retry";
import vectors from "../test/vectors.json";

const SECRET = vectors.ticket.secret;
const NOW = Date.parse("2026-01-01T00:00:00Z");
const SAS = "https://gtrtest.blob.core.windows.net/takeouts?sp=racw&se=2026-01-02T00%3A00%3A00Z&sig=SIG%3D";
const CONFIG = { proxyBase: "https://proxy.example.com/", secret: SECRET, containerSasUrl: SAS };
const JOB = { takeoutUrl: "https://takeout.google.com/takeout/download?j=abc", cookie: "SID=abc", blobName: "dir/export 1.zip" };
const MIB = 1024 * 1024;
const TARGET: Target = { proxyBase: "https://proxy.example.com", secret: SECRET, containerSasUrl: SAS, blobName: JOB.blobName };
const retry = { sleep: async (): Promise<void> => undefined };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Handler = (call: Call, init: RequestInit) => Response | undefined | Promise<Response | undefined>;

function fakeFetch(handler: (call: Call, init: RequestInit) => Response | Promise<Response>): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (url, init = {}) => {
    const call: Call = { url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body as string | undefined };
    calls.push(call);
    return handler(call, init);
  };
  return { fetchFn, calls };
}

function probeResponse(total: number): Response {
  return new Response("x", { status: 206, headers: { "content-range": `bytes 0-0/${total}`, "content-type": "application/zip" } });
}

function azureXml(status: number, code: string): Response {
  return new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>secret https://x/?sig=LEAK</Message></Error>`, { status });
}

function proxyAndAzure(total: number, overrides: Handler = () => undefined): { fetchFn: FetchFn; calls: Call[] } {
  return fakeFetch(async (call, init) => {
    const override = await overrides(call, init);
    if (override) {
      return override;
    }
    return call.url.includes("/t/") ? probeResponse(total) : new Response(null, { status: 201 });
  });
}

async function codeOf(promise: Promise<unknown>): Promise<TransloadErrorCode | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof TransloadError ? error.code : undefined;
  }
  return undefined;
}

describe("probe", () => {
  it("reads the total from Content-Range with a ranged, redirect-manual, credential-less GET", async () => {
    const { fetchFn, calls } = fakeFetch(() => probeResponse(12345));
    expect(await probe(fetchFn, "https://proxy.example.com/t/abc")).toEqual({ total: 12345, contentDisposition: null });
    expect(calls[0]).toMatchObject({ url: "https://proxy.example.com/t/abc", method: "GET", headers: { range: "bytes=0-0" } });
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("returns the Content-Disposition header", async () => {
    const { fetchFn } = fakeFetch(() => new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/9", "content-disposition": 'attachment; filename="a.zip"' } }));
    expect(await probe(fetchFn, "u")).toEqual({ total: 9, contentDisposition: 'attachment; filename="a.zip"' });
  });

  it.each([
    [410, "ticket_expired", /ticket expired, start the download again|ticket expired\. start the download again/i],
    [403, "proxy_rejected", /secret does not match or the URL is not a Takeout download/],
    [401, "source_unavailable", /sign in to google/i],
    [302, "source_unavailable", /sign in to google/i],
    [416, "empty_archive", /empty/],
    [500, "source_unavailable", /HTTP 500/],
  ] as const)("maps status %i to %s", async (status, code, message) => {
    const { fetchFn } = fakeFetch(() => new Response(null, { status }));
    const error = await probe(fetchFn, "https://proxy.example.com/t/abc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransloadError);
    expect((error as TransloadError).code).toBe(code);
    expect((error as TransloadError).message).toMatch(message);
  });

  it("rejects an HTML sign-in page served as 206", async () => {
    const { fetchFn } = fakeFetch(() => new Response("<html>", { status: 206, headers: { "content-type": "text/html; charset=utf-8", "content-range": "bytes 0-0/1" } }));
    expect(await codeOf(probe(fetchFn, "u"))).toBe("source_unavailable");
  });

  it.each([null, "bytes 0-0/*", "bytes 5-9/20", "garbage"])("rejects Content-Range %s", async (range) => {
    const { fetchFn } = fakeFetch(() => new Response("x", { status: 206, ...(range && { headers: { "content-range": range } }) }));
    expect(await codeOf(probe(fetchFn, "u"))).toBe("protocol_error");
  });

  it("reports a network failure without leaking the URL", async () => {
    const fetchFn: FetchFn = async (url) => {
      throw new TypeError(`failed ${url}`);
    };
    const error = (await probe(fetchFn, "https://proxy.example.com/t/TICKET").catch((e: unknown) => e)) as TransloadError;
    expect(error.code).toBe("proxy_unreachable");
    expect(error.message).not.toContain("TICKET");
  });

  it("reports aborted when the signal fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn: FetchFn = async () => {
      throw new DOMException("aborted", "AbortError");
    };
    expect(await codeOf(probe(fetchFn, "u", controller.signal))).toBe("aborted");
  });
});

describe("planBlocks", () => {
  it("splits an exact multiple", () => {
    expect(planBlocks(4 * MIB, 2 * MIB).map(({ start, size }) => [start, size])).toEqual([
      [0, 2 * MIB],
      [2 * MIB, 2 * MIB],
    ]);
  });

  it("gives the remainder to the last block", () => {
    const blocks = planBlocks(5 * MIB, 2 * MIB);
    expect(blocks.map((block) => block.size)).toEqual([2 * MIB, 2 * MIB, MIB]);
    expect(blocks[2]?.start).toBe(4 * MIB);
  });

  it("handles a single byte", () => {
    expect(planBlocks(1, 1000 * MIB)).toEqual([{ index: 0, blockId: btoa("block-000000"), start: 0, size: 1 }]);
  });

  it("uses equal-length base64 block ids", () => {
    const ids = planBlocks(12, 1).map((block) => block.blockId);
    expect(ids[11]).toBe(btoa("block-000011"));
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
  });

  it("allows exactly 50,000 blocks and rejects more", () => {
    expect(planBlocks(50_000, 1)).toHaveLength(50_000);
    expect(() => planBlocks(50_001, 1)).toThrow(TransloadError);
    expect(() => planBlocks(50_001, 1)).toThrow(/50000/);
  });

  it("rejects a non-positive block size", () => {
    expect(() => planBlocks(10, 0)).toThrow(RangeError);
  });
});

describe("stageBlock", () => {
  const block: Block = { index: 1, blockId: btoa("block-000001"), start: 100, size: 50 };

  it("sends an empty PUT to the relay with the copy source, inclusive range and bearer", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 201 }));
    await stageBlock(fetchFn, TARGET, block, "https://proxy.example.com/t/TICKET");
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(buildRelayUrl(TARGET.proxyBase, SAS, TARGET.blobName, { comp: "block", blockid: block.blockId }));
    expect(call.url).toContain(`blockid=${encodeURIComponent(block.blockId)}`);
    expect(call.url).toContain("sig=SIG%3D");
    expect(call.url).toContain("/azure/gtrtest/takeouts/dir/export%201.zip?");
    expect(call.body).toBeUndefined();
    expect(call.headers).toMatchObject({
      authorization: `Bearer ${SECRET}`,
      "x-ms-version": "2021-08-06",
      "x-ms-copy-source": "https://proxy.example.com/t/TICKET",
      "x-ms-source-range": "bytes=100-149",
    });
  });

  it("encodes block id characters that are unsafe in a query", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 201 }));
    await stageBlock(fetchFn, TARGET, { ...block, blockId: "a+b/c==" }, "s");
    expect(calls[0]?.url).toContain("blockid=a%2Bb%2Fc%3D%3D");
  });

  it.each([
    [403, "AuthenticationFailed", "azure_rejected", /SAS URL \(expired or missing permissions\)/],
    [403, "AuthorizationFailure", "azure_rejected", /firewall/],
    [404, "ContainerNotFound", "azure_rejected", /container not found/i],
    [409, "CannotVerifyCopySource", "source_unavailable", /ticket may have expired/],
    [400, "InvalidQueryParameterValue", "azure_rejected", /HTTP 400 \(InvalidQueryParameterValue\)/],
  ] as const)("maps Azure %i %s", async (status, azureCode, code, message) => {
    const { fetchFn } = fakeFetch(() => azureXml(status, azureCode));
    const error = (await stageBlock(fetchFn, TARGET, block, "s").catch((e: unknown) => e)) as TransloadError;
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain("LEAK");
    expect(error.message).not.toContain("SIG");
  });

  it("maps a proxy 401 to proxy_rejected", async () => {
    const { fetchFn } = fakeFetch(() => new Response(null, { status: 401 }));
    expect(await codeOf(stageBlock(fetchFn, TARGET, block, "s"))).toBe("proxy_rejected");
  });

  it("falls back to a generic message for an unparseable body", async () => {
    const { fetchFn } = fakeFetch(() => new Response("x".repeat(10_000), { status: 502 }));
    const error = (await stageBlock(fetchFn, TARGET, block, "s").catch((e: unknown) => e)) as TransloadError;
    expect(error.message).toBe("Azure returned HTTP 502 while staging block 2.");
  });
});

describe("commitBlockList", () => {
  it("PUTs the block list XML in order", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 201 }));
    await commitBlockList(fetchFn, TARGET, planBlocks(3, 1));
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe(buildRelayUrl(TARGET.proxyBase, SAS, TARGET.blobName, { comp: "blocklist" }));
    expect(call.headers["content-type"]).toBe("application/xml");
    expect(call.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    expect(call.body).toBe(`<?xml version="1.0" encoding="utf-8"?><BlockList>${[0, 1, 2].map((i) => `<Latest>${btoa(`block-00000${i}`)}</Latest>`).join("")}</BlockList>`);
  });

  it("sends x-ms-access-tier when the target has one", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 201 }));
    await commitBlockList(fetchFn, { ...TARGET, accessTier: "Archive" }, planBlocks(1, 1));
    expect(calls[0]!.headers["x-ms-access-tier"]).toBe("Archive");
  });

  it("omits x-ms-access-tier when unset", async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 201 }));
    await commitBlockList(fetchFn, TARGET, planBlocks(1, 1));
    expect(calls[0]!.headers).not.toHaveProperty("x-ms-access-tier");
  });

  it("maps a rejected commit", async () => {
    const { fetchFn } = fakeFetch(() => azureXml(400, "InvalidBlockList"));
    expect((await commitBlockList(fetchFn, TARGET, planBlocks(1, 1)).catch((e: unknown) => e)) as TransloadError).toMatchObject({ code: "azure_rejected", message: "Azure returned HTTP 400 (InvalidBlockList) while committing the blob." });
  });
});

describe("transload", () => {
  it("runs the full flow against a fake proxy and Azure", async () => {
    const progress: [number, number][] = [];
    const { fetchFn, calls } = proxyAndAzure(5 * MIB);
    const result = await transload(CONFIG, JOB, { blockSizeMiB: 2, fetch: fetchFn, now: () => NOW, retry, onProgress: (done, total) => progress.push([done, total]) });

    expect(result).toEqual({ bytes: 5 * MIB, blocks: 3, durationMs: 0 });
    const [probeCall, ...rest] = calls;
    expect(probeCall?.url).toMatch(/^https:\/\/proxy\.example\.com\/t\/[A-Za-z0-9_-]+$/);
    const stages = rest.filter((call) => call.url.includes("comp=block&"));
    const commit = rest.filter((call) => call.url.includes("comp=blocklist"));
    expect(stages).toHaveLength(3);
    expect(commit).toHaveLength(1);
    expect(rest.at(-1)).toBe(commit[0]);
    expect(stages.map((call) => call.headers["x-ms-source-range"])).toEqual([`bytes=0-${2 * MIB - 1}`, `bytes=${2 * MIB}-${4 * MIB - 1}`, `bytes=${4 * MIB}-${5 * MIB - 1}`]);
    expect(stages.every((call) => call.headers["x-ms-copy-source"] === probeCall?.url)).toBe(true);
    expect(rest.every((call) => call.url.startsWith("https://proxy.example.com/azure/gtrtest/takeouts/dir/export%201.zip?"))).toBe(true);
    expect(progress[0]).toEqual([0, 5 * MIB]);
    expect(progress.at(-1)).toEqual([5 * MIB, 5 * MIB]);
    expect(progress.map(([done]) => done)).toEqual([...progress.map(([done]) => done)].sort((a, b) => a - b));
  });

  it("carries the access tier to the commit only", async () => {
    const { fetchFn, calls } = proxyAndAzure(3 * MIB);
    await transload({ ...CONFIG, accessTier: "Cool" }, JOB, { blockSizeMiB: 1, fetch: fetchFn, now: () => NOW, retry });
    const tiered = calls.filter((call) => call.headers["x-ms-access-tier"] !== undefined);
    expect(tiered).toHaveLength(1);
    expect(tiered[0]!.url).toContain("comp=blocklist");
    expect(tiered[0]!.headers["x-ms-access-tier"]).toBe("Cool");
  });

  it("stages all blocks concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const { fetchFn } = proxyAndAzure(4 * MIB, async (call) => {
      if (!call.url.includes("comp=block&")) {
        return undefined;
      }
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return new Response(null, { status: 201 });
    });
    await transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: fetchFn, now: () => NOW, retry });
    expect(peak).toBe(4);
  });

  it("aborts the remaining blocks on the first failure and skips the commit", async () => {
    const signals: AbortSignal[] = [];
    const { fetchFn, calls } = proxyAndAzure(3 * MIB, (call, init) => {
      if (!call.url.includes("comp=block&")) {
        return undefined;
      }
      if (call.headers["x-ms-source-range"]?.startsWith("bytes=0-")) {
        return azureXml(403, "AuthenticationFailed");
      }
      signals.push(init.signal!);
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    const error = (await transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: fetchFn, now: () => NOW, retry }).catch((e: unknown) => e)) as TransloadError;
    expect(error.code).toBe("azure_rejected");
    expect(error.message).toMatch(/SAS URL/);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(calls.some((call) => call.url.includes("comp=blocklist"))).toBe(false);
  });

  it("retries a 503 on stage then succeeds", async () => {
    let failures = 1;
    const { fetchFn, calls } = proxyAndAzure(MIB, (call) => (call.url.includes("comp=block&") && failures-- > 0 ? new Response(null, { status: 503 }) : undefined));
    await transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: fetchFn, now: () => NOW, retry });
    expect(calls.filter((call) => call.url.includes("comp=block&"))).toHaveLength(2);
  });

  it("retries 409 on stage but not on commit", async () => {
    let stage409 = 1;
    const ok = proxyAndAzure(MIB, (call) => (call.url.includes("comp=block&") && stage409-- > 0 ? new Response(null, { status: 409 }) : undefined));
    await transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: ok.fetchFn, now: () => NOW, retry });

    const failing = proxyAndAzure(MIB, (call) => (call.url.includes("comp=blocklist") ? azureXml(409, "Conflict") : undefined));
    expect(await codeOf(transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: failing.fetchFn, now: () => NOW, retry }))).toBe("azure_rejected");
    expect(failing.calls.filter((call) => call.url.includes("comp=blocklist"))).toHaveLength(1);
  });

  it("aborts in-flight blocks when the caller's signal fires", async () => {
    const controller = new AbortController();
    const { fetchFn } = proxyAndAzure(2 * MIB, (call) => {
      if (!call.url.includes("comp=block&")) {
        return undefined;
      }
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    expect(await codeOf(transload(CONFIG, JOB, { blockSizeMiB: 1, fetch: fetchFn, signal: controller.signal, now: () => NOW, retry }))).toBe("aborted");
  });

  it("refuses to start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchFn, calls } = proxyAndAzure(1);
    expect(await codeOf(transload(CONFIG, JOB, { fetch: fetchFn, signal: controller.signal, now: () => NOW, retry }))).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["not https", { ...CONFIG, containerSasUrl: SAS.replace("https", "http") }, "sas_invalid"],
    ["blob-level SAS", { ...CONFIG, containerSasUrl: SAS.replace("/takeouts?", "/takeouts/blob.zip?") }, "sas_invalid"],
    ["read-only SAS", { ...CONFIG, containerSasUrl: SAS.replace("sp=racw", "sp=rl") }, "sas_invalid"],
    ["expired SAS", { ...CONFIG, containerSasUrl: SAS.replace("2026-01-02", "2025-12-31") }, "sas_expired"],
  ] as const)("rejects a bad SAS (%s) before any request", async (_name, config, code) => {
    const { fetchFn, calls } = proxyAndAzure(1);
    expect(await codeOf(transload(config, JOB, { fetch: fetchFn, now: () => NOW, retry }))).toBe(code);
    expect(calls).toHaveLength(0);
  });

  it.each(["/leading.zip", "a/../b.zip", "..", "./a.zip", ""])("rejects blob name %j", async (blobName) => {
    const { fetchFn, calls } = proxyAndAzure(1);
    expect(await codeOf(transload(CONFIG, { ...JOB, blobName }, { fetch: fetchFn, now: () => NOW, retry }))).toBe("invalid_blob_name");
    expect(calls).toHaveLength(0);
  });

  it("derives the blob name from the probe's Content-Disposition", async () => {
    const disposition = "attachment; filename=real.zip";
    const { fetchFn, calls } = proxyAndAzure(1, (call) => (call.url.includes("/t/") ? new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1", "content-disposition": disposition } }) : undefined));
    await transload(CONFIG, { ...JOB, blobName: (contentDisposition) => (contentDisposition === disposition ? "named/real.zip" : "wrong") }, { fetch: fetchFn, now: () => NOW, retry });
    const stage = calls.find((call) => call.method === "PUT");
    expect(stage?.url).toContain("/azure/gtrtest/takeouts/named/real.zip?");
  });

  it("rejects an invalid blob name returned by the resolver before staging", async () => {
    const { fetchFn, calls } = proxyAndAzure(1);
    expect(await codeOf(transload(CONFIG, { ...JOB, blobName: () => "../x" }, { fetch: fetchFn, now: () => NOW, retry }))).toBe("invalid_blob_name");
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it("rejects a ticket that overflows Azure's 2 KiB copy-source limit", async () => {
    const noise = Array.from(crypto.getRandomValues(new Uint8Array(4000)), (byte) => byte.toString(16)).join("");
    const { fetchFn, calls } = proxyAndAzure(1);
    expect(await codeOf(transload(CONFIG, { ...JOB, cookie: noise }, { fetch: fetchFn, now: () => NOW, retry }))).toBe("ticket_too_long");
    expect(calls).toHaveLength(0);
  });

  it("rejects a zero-length archive", async () => {
    const { fetchFn } = proxyAndAzure(0);
    expect(await codeOf(transload(CONFIG, JOB, { fetch: fetchFn, now: () => NOW, retry }))).toBe("empty_archive");
  });

  it("surfaces an expired ticket from the probe", async () => {
    const { fetchFn } = proxyAndAzure(1, (call) => (call.url.includes("/t/") ? new Response(null, { status: 410 }) : undefined));
    expect(await codeOf(transload(CONFIG, JOB, { fetch: fetchFn, now: () => NOW, retry }))).toBe("ticket_expired");
  });

  it("rejects a plain-http proxy URL", async () => {
    const { fetchFn } = proxyAndAzure(1);
    await expect(transload({ ...CONFIG, proxyBase: "http://proxy.example.com" }, JOB, { fetch: fetchFn, now: () => NOW, retry })).rejects.toThrow(/https/);
  });
});
