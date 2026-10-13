export interface TicketPayload {
  u: string;
  c: string;
}

export const TICKET_TTL_SECONDS = 6 * 60 * 60;

const IV_BYTES = 12;
const HKDF_SALT = "gtr-proxy";
const HKDF_INFO = "ticket v1";

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(HKDF_SALT), info: encoder.encode(HKDF_INFO) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Response(new Response(bytes).body!.pipeThrough(new CompressionStream("deflate-raw")));
  return new Uint8Array(await output.arrayBuffer());
}

export interface SealOptions {
  now?: number;
  iv?: Uint8Array<ArrayBuffer>;
}

export async function seal(secret: string, payload: TicketPayload, options: SealOptions = {}): Promise<string> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const iv = options.iv ?? crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const json = JSON.stringify({ u: payload.u, c: payload.c, exp: now + TICKET_TTL_SECONDS });
  const compressed = await deflateRaw(encoder.encode(json));
  const key = await deriveKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed);
  const ticket = new Uint8Array(IV_BYTES + encrypted.byteLength);
  ticket.set(iv);
  ticket.set(new Uint8Array(encrypted), IV_BYTES);
  return toBase64Url(ticket);
}
