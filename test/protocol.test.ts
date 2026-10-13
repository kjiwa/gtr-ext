import { describe, expect, it } from "vitest";
import { buildRelayUrl, sasUrlToRelayPath } from "../src/protocol/azure";
import { isTakeoutUrl } from "../src/protocol/takeout";
import { deriveKey, seal, TICKET_TTL_SECONDS, toBase64Url } from "../src/protocol/ticket";
import { normalizeProxyBase, ticketUrl } from "../src/protocol/urls";
import vectors from "./vectors.json";

const { secret, iv, now, payload, expectedTicket } = vectors.ticket;
const IV_BYTES = 12;

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function open(ticket: string): Promise<{ u: string; c: string; exp: number }> {
  const bytes = fromBase64Url(ticket);
  const key = await deriveKey(secret);
  const compressed = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES));
  const inflated = new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate-raw")));
  return JSON.parse(await inflated.text()) as { u: string; c: string; exp: number };
}

describe("ticket", () => {
  it("decrypts the expected vector to the payload", async () => {
    expect(await open(expectedTicket)).toEqual({ ...payload, exp: now + TICKET_TTL_SECONDS });
  });

  it("round-trips a sealed ticket with a fixed iv", async () => {
    const ivBytes = fromBase64Url(iv);
    const ticket = await seal(secret, payload, { now, iv: ivBytes });
    expect(fromBase64Url(ticket).slice(0, IV_BYTES)).toEqual(ivBytes);
    expect(await open(ticket)).toEqual({ ...payload, exp: now + TICKET_TTL_SECONDS });
  });

  it("uses a random iv by default", async () => {
    expect(await seal(secret, payload)).not.toBe(await seal(secret, payload));
  });

  it("sets exp to now plus the TTL", async () => {
    expect(TICKET_TTL_SECONDS).toBe(21600);
    const ticket = await seal(secret, payload, { now: 1000 });
    expect((await open(ticket)).exp).toBe(1000 + TICKET_TTL_SECONDS);
  });

  it("derives a non-extractable AES-256-GCM key", async () => {
    const key = await deriveKey(secret);
    expect(key.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect(key.extractable).toBe(false);
  });

  it("encodes base64url without padding", () => {
    expect(toBase64Url(new Uint8Array([251, 255, 254, 1]))).toBe("-__-AQ");
  });
});

describe("isTakeoutUrl", () => {
  it.each(vectors.takeoutUrls.accept)("accepts %s", (url) => {
    expect(isTakeoutUrl(url)).toBe(true);
  });

  it.each(vectors.takeoutUrls.reject)("rejects %j", (url) => {
    expect(isTakeoutUrl(url)).toBe(false);
  });
});

describe("azure paths", () => {
  it.each(vectors.azurePaths)("maps $relayPath", ({ sasUrl, relayPath }) => {
    expect(sasUrlToRelayPath(sasUrl)).toBe(relayPath);
  });

  it("rejects non-Azure SAS URLs", () => {
    expect(() => sasUrlToRelayPath("https://example.com/c/b?sig=x")).toThrow();
    expect(() => sasUrlToRelayPath("http://acct.blob.core.windows.net/c/b")).toThrow();
    expect(() => sasUrlToRelayPath("https://evil.example/.blob.core.windows.net/c/b")).toThrow();
  });
});

describe("buildRelayUrl", () => {
  const container = "https://gtrtest.blob.core.windows.net/takeouts?sp=racw&sig=u72%2FzW%3D";

  it("appends the blob to the container path and keeps the SAS verbatim", () => {
    expect(buildRelayUrl("https://p.example", container, "export.zip")).toBe("https://p.example/azure/gtrtest/takeouts/export.zip?sp=racw&sig=u72%2FzW%3D");
  });

  it("percent-encodes each blob name segment", () => {
    expect(buildRelayUrl("https://p.example", container, "2026/a b+c%.zip")).toBe("https://p.example/azure/gtrtest/takeouts/2026/a%20b%2Bc%25.zip?sp=racw&sig=u72%2FzW%3D");
  });

  it("url-encodes extra query values", () => {
    const url = buildRelayUrl("https://p.example", container, "b.zip", { comp: "block", blockid: "AAA+/=" });
    expect(url).toBe("https://p.example/azure/gtrtest/takeouts/b.zip?sp=racw&sig=u72%2FzW%3D&comp=block&blockid=AAA%2B%2F%3D");
  });

  it("tolerates a trailing slash and a missing SAS", () => {
    expect(buildRelayUrl("https://p.example", "https://gtrtest.blob.core.windows.net/takeouts/", "b.zip", { comp: "list" })).toBe("https://p.example/azure/gtrtest/takeouts/b.zip?comp=list");
  });

  it("rejects non-Azure containers", () => {
    expect(() => buildRelayUrl("https://p.example", "https://example.com/c?sig=x", "b")).toThrow();
  });
});

describe("proxy URLs", () => {
  it.each([
    ["https://p.example", "https://p.example"],
    ["https://p.example/", "https://p.example"],
    ["  https://p.example/gtr/ ", "https://p.example/gtr"],
    ["HTTPS://P.example:8443/", "https://p.example:8443"],
    ["http://localhost:8787/", "http://localhost:8787"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeProxyBase(input)).toBe(expected);
  });

  it.each(["", "not a url", "http://p.example", "http://localhost.evil.example", "ftp://p.example", "https://user:pw@p.example", "https://user@p.example", "https://p.example/?a=1", "https://p.example/#x", "https://p.example/?"])("rejects %j", (input) => {
    expect(() => normalizeProxyBase(input)).toThrow();
  });

  it("builds the ticket URL", () => {
    expect(ticketUrl("https://p.example", "abc_-")).toBe("https://p.example/t/abc_-");
  });
});
