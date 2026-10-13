import { buildRelayUrl } from "./protocol/azure";
import { seal } from "./protocol/ticket";
import { normalizeProxyBase, ticketUrl } from "./protocol/urls";
import { retrying, type FetchFn, type RetryOptions } from "./retry";
import { parseContainerSas, SasError } from "./sas";

export type TransloadErrorCode = "sas_invalid" | "sas_expired" | "invalid_blob_name" | "ticket_too_long" | "ticket_expired" | "proxy_rejected" | "proxy_unreachable" | "source_unavailable" | "empty_archive" | "too_large" | "protocol_error" | "azure_rejected" | "aborted";

export class TransloadError extends Error {
  constructor(
    readonly code: TransloadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransloadError";
  }
}

export interface TransloadConfig {
  proxyBase: string;
  secret: string;
  containerSasUrl: string;
}

export interface TransloadJob {
  takeoutUrl: string;
  cookie: string;
  blobName: string | ((contentDisposition: string | null) => string);
}

export interface TransloadOptions {
  blockSizeMiB?: number;
  signal?: AbortSignal;
  onProgress?: (bytesDone: number, bytesTotal: number) => void;
  fetch?: FetchFn;
  now?: () => number;
  retry?: RetryOptions;
}

export interface TransloadResult {
  bytes: number;
  blocks: number;
  durationMs: number;
}

export interface Target {
  proxyBase: string;
  secret: string;
  containerSasUrl: string;
  blobName: string;
}

export interface Block {
  index: number;
  blockId: string;
  start: number;
  size: number;
}

const MIB = 1024 * 1024;
const DEFAULT_BLOCK_SIZE_MIB = 1000;
const MAX_BLOCKS = 50_000;
const MAX_COPY_SOURCE_LENGTH = 2048;
const MAX_ERROR_BODY_BYTES = 2048;
const AZURE_VERSION = "2021-08-06";
const CONTENT_RANGE = /^bytes 0-0\/(\d+)$/;
const AZURE_CODE = /<Code>([A-Za-z0-9]+)<\/Code>/;

const AZURE_ERRORS: Record<string, { code: TransloadErrorCode; message: string }> = {
  AuthenticationFailed: { code: "azure_rejected", message: "Azure rejected the SAS URL (expired or missing permissions)." },
  AuthorizationFailure: { code: "azure_rejected", message: "Azure denied the request. Check the SAS permissions and the storage account firewall." },
  ContainerNotFound: { code: "azure_rejected", message: "Azure container not found. Check the SAS URL." },
  CannotVerifyCopySource: { code: "source_unavailable", message: "Azure could not read the Takeout archive through the proxy. The ticket may have expired or Google refused the cookie." },
};

function abortedError(): TransloadError {
  return new TransloadError("aborted", "The transfer was cancelled.");
}

// Network failure messages can embed the request URL, so only the code is kept.
async function send(fetchFn: FetchFn, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch {
    throw init.signal?.aborted ? abortedError() : new TransloadError("proxy_unreachable", "Could not reach the proxy. Check its URL and your connection.");
  }
}

async function readBodySnippet(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text.slice(0, MAX_ERROR_BODY_BYTES);
}

async function azureError(response: Response, step: string): Promise<TransloadError> {
  if (response.status === 401) {
    return new TransloadError("proxy_rejected", "The proxy rejected the secret. Check it in the extension options.");
  }
  const azureCode = AZURE_CODE.exec(await readBodySnippet(response))?.[1];
  const known = azureCode === undefined ? undefined : AZURE_ERRORS[azureCode];
  if (known) {
    return new TransloadError(known.code, known.message);
  }
  const suffix = azureCode === undefined ? "" : ` (${azureCode})`;
  return new TransloadError("azure_rejected", `Azure returned HTTP ${response.status}${suffix} while ${step}.`);
}

const SIGN_IN_MESSAGE = "Google did not return the archive. Sign in to Google, then start the download again.";

async function probeFailure(response: Response): Promise<TransloadError> {
  await response.body?.cancel();
  const { status } = response;
  if (status === 410) {
    return new TransloadError("ticket_expired", "The ticket expired. Start the download again.");
  }
  if (status === 403) {
    return new TransloadError("proxy_rejected", "The proxy rejected the ticket: the secret does not match or the URL is not a Takeout download.");
  }
  if (status === 416) {
    return new TransloadError("empty_archive", "The Takeout archive is empty.");
  }
  if (status === 401 || response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
    return new TransloadError("source_unavailable", SIGN_IN_MESSAGE);
  }
  return new TransloadError("source_unavailable", `Takeout returned HTTP ${status}.`);
}

export interface ProbeResult {
  total: number;
  contentDisposition: string | null;
}

export async function probe(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const response = await send(fetchFn, url, { headers: { Range: "bytes=0-0" }, redirect: "manual", credentials: "omit", ...(signal && { signal }) });
  if (response.status !== 206) {
    throw await probeFailure(response);
  }
  await response.body?.cancel();
  if (response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
    throw new TransloadError("source_unavailable", SIGN_IN_MESSAGE);
  }
  const total = CONTENT_RANGE.exec(response.headers.get("content-range") ?? "")?.[1];
  if (total === undefined || !Number.isSafeInteger(Number(total))) {
    throw new TransloadError("protocol_error", "The proxy returned an unexpected response to the size probe.");
  }
  return { total: Number(total), contentDisposition: response.headers.get("content-disposition") };
}

export function planBlocks(total: number, blockBytes: number): Block[] {
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError("block size must be a positive integer");
  }
  const count = Math.ceil(total / blockBytes);
  if (count > MAX_BLOCKS) {
    throw new TransloadError("too_large", `The archive needs ${count} blocks, more than Azure's limit of ${MAX_BLOCKS}. Use a larger block size.`);
  }
  return Array.from({ length: count }, (_, index) => {
    const start = index * blockBytes;
    return { index, blockId: btoa(`block-${String(index).padStart(6, "0")}`), start, size: Math.min(blockBytes, total - start) };
  });
}

function azureHeaders(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}`, "x-ms-version": AZURE_VERSION };
}

// An empty PUT body makes fetch send Content-Length: 0, a header scripts may not set.
export async function stageBlock(fetchFn: FetchFn, target: Target, block: Block, copySource: string, signal?: AbortSignal): Promise<void> {
  const url = buildRelayUrl(target.proxyBase, target.containerSasUrl, target.blobName, { comp: "block", blockid: block.blockId });
  const headers = { ...azureHeaders(target.secret), "x-ms-copy-source": copySource, "x-ms-source-range": `bytes=${block.start}-${block.start + block.size - 1}` };
  const response = await send(fetchFn, url, { method: "PUT", headers, ...(signal && { signal }) });
  if (response.status !== 201) {
    throw await azureError(response, `staging block ${block.index + 1}`);
  }
  await response.body?.cancel();
}

function blockListXml(blocks: Block[]): string {
  const entries = blocks.map((block) => `<Latest>${block.blockId}</Latest>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${entries}</BlockList>`;
}

export async function commitBlockList(fetchFn: FetchFn, target: Target, blocks: Block[], signal?: AbortSignal): Promise<void> {
  const url = buildRelayUrl(target.proxyBase, target.containerSasUrl, target.blobName, { comp: "blocklist" });
  const headers = { ...azureHeaders(target.secret), "Content-Type": "application/xml" };
  const response = await send(fetchFn, url, { method: "PUT", headers, body: blockListXml(blocks), ...(signal && { signal }) });
  if (response.status !== 201) {
    throw await azureError(response, "committing the blob");
  }
  await response.body?.cancel();
}

function validateBlobName(blobName: string): void {
  const segments = blobName.split("/");
  if (blobName === "" || segments[0] === "" || segments.some((segment) => segment === "." || segment === "..")) {
    throw new TransloadError("invalid_blob_name", "The blob name must be a relative path without leading slashes or dot segments.");
  }
}

function validateSas(containerSasUrl: string, now: number): void {
  try {
    parseContainerSas(containerSasUrl, now);
  } catch (error) {
    if (error instanceof SasError) {
      throw new TransloadError(error.code === "expired" ? "sas_expired" : "sas_invalid", error.message);
    }
    throw error;
  }
}

function requireFittingCopySource(copySource: string): void {
  if (copySource.length > MAX_COPY_SOURCE_LENGTH) {
    throw new TransloadError("ticket_too_long", "The Takeout cookie is too large to fit in Azure's 2 KiB copy-source limit. Sign out of Google accounts you do not need, then start the download again.");
  }
}

async function stageAll(fetchFn: FetchFn, target: Target, blocks: Block[], copySource: string, total: number, options: TransloadOptions): Promise<void> {
  const inner = new AbortController();
  const abort = (): void => inner.abort();
  if (options.signal?.aborted) {
    abort();
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  let done = 0;
  try {
    await Promise.all(
      blocks.map(async (block) => {
        try {
          await stageBlock(fetchFn, target, block, copySource, inner.signal);
        } catch (error) {
          abort();
          throw error;
        }
        done += block.size;
        options.onProgress?.(done, total);
      }),
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function transload(config: TransloadConfig, job: TransloadJob, options: TransloadOptions = {}): Promise<TransloadResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { signal } = options;
  const base = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchFn = retrying(base, { now, ...options.retry });
  const stageFetch = retrying(base, { now, ...options.retry, extraStatuses: [409] });
  const proxyBase = normalizeProxyBase(config.proxyBase);

  if (signal?.aborted) {
    throw abortedError();
  }
  if (typeof job.blobName === "string") {
    validateBlobName(job.blobName);
  }
  validateSas(config.containerSasUrl, startedAt);
  const ticket = await seal(config.secret, { u: job.takeoutUrl, c: job.cookie }, { now: Math.floor(startedAt / 1000) });
  const copySource = ticketUrl(proxyBase, ticket);
  requireFittingCopySource(copySource);

  const { total, contentDisposition } = await probe(fetchFn, copySource, signal);
  if (total === 0) {
    throw new TransloadError("empty_archive", "The Takeout archive is empty.");
  }
  const blobName = typeof job.blobName === "string" ? job.blobName : job.blobName(contentDisposition);
  validateBlobName(blobName);
  const target: Target = { proxyBase, secret: config.secret, containerSasUrl: config.containerSasUrl, blobName };
  const blocks = planBlocks(total, (options.blockSizeMiB ?? DEFAULT_BLOCK_SIZE_MIB) * MIB);
  options.onProgress?.(0, total);
  await stageAll(stageFetch, target, blocks, copySource, total, options);
  await commitBlockList(fetchFn, target, blocks, signal);
  return { bytes: total, blocks: blocks.length, durationMs: now() - startedAt };
}
