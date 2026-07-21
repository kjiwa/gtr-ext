import { ContainerClient } from "./jeContainerClient";
import "isomorphic-fetch";
import { v4 as uuidv4 } from "uuid";
import { btoa } from "abab";
import { Download } from "./state";
import { BUILT_IN_PROXY_BASE, PROXY_TOKEN_PARAM } from "./constants";

interface JobPlan {
  chunks: {
    blockId: string;
    start: number;
    size: number;
  }[];
  length: number;
}

export function sourceToGtrProxySource(
  source: string,
  proxyBase?: string,
  encodedCookies?: string,
  proxyAuthToken?: string
): string {
  if (!proxyBase) {
    proxyBase = BUILT_IN_PROXY_BASE;
  }
  // Replace all %2F with %252F and remove scheme
  const url = source.replace(/%2F/g, "%252F").replace(/https?:\/\//, "");

  let proxyUrl = `${proxyBase}/p/${url}`;
  if (encodedCookies) {
    const separator = proxyUrl.includes("?") ? "&" : "?";
    proxyUrl += `${separator}a=${encodeURIComponent(encodedCookies)}`;
  }
  if (proxyAuthToken) {
    const separator = proxyUrl.includes("?") ? "&" : "?";
    proxyUrl += `${separator}${PROXY_TOKEN_PARAM}=${encodeURIComponent(
      proxyAuthToken
    )}`;
  }

  // Azure imposes a 2 KiB limit on the length of the source URL in
  // the Put Blob From Url API.
  if (proxyUrl.length > 2048) {
    throw new Error(
      `Proxy URL length (${proxyUrl.length}) exceeds the maximum of 2048 bytes.`
    );
  }

  return proxyUrl;
}

export async function createJobPlan(
  source_url: string,
  chunk_size_mb?: number
): Promise<JobPlan> {
  if (!chunk_size_mb) {
    chunk_size_mb = 3000;
  }
  // Fetch HEAD of source
  const resp = await fetch(source_url, {
    method: "HEAD"
  });
  const content_length_header = resp.headers.get("content-length");
  if (!content_length_header) {
    throw new Error("No content-length header");
  }
  const length = parseInt(content_length_header);

  console.log(`Got length bytes: ${length}`);

  // Divide into chunks
  const chunkSize = chunk_size_mb * 1024 * 1024;
  const numChunks = Math.ceil(length / chunkSize);
  console.log(`Will divide into ${numChunks} chunks`);
  let chunks = [];
  for (let i = 0; i < length; i += chunkSize)
    chunks.push({
      blockId: btoa(uuidv4())!,
      start: i,
      size: Math.min(length - i, chunkSize)
    });
  return {
    chunks: chunks,
    length
  };
}

export async function transload(
  sourceUrl: string,
  destination: string,
  name: string,
  proxyBase?: string,
  chunk_size_mb?: number,
  proxyAuthToken?: string
): Promise<Download> {
  // Note: sourceUrl and destination may carry credentials (cookies, a proxy
  // auth token, and/or an Azure SAS token respectively), so they must never
  // be logged.
  console.log(`Transloading ${name}`);

  const containerClient = new ContainerClient(destination);
  if (!proxyBase) {
    proxyBase = BUILT_IN_PROXY_BASE;
  }
  const blobClient = containerClient.getBlockBlobClient(
    name,
    proxyBase,
    proxyAuthToken
  );
  const jobPlan = await createJobPlan(sourceUrl, chunk_size_mb);
  console.log(`Got job plan with ${jobPlan.chunks.length} chunk(s)`);
  console.log(`Staging Blocks`);
  const responses = jobPlan.chunks.map(async (chunk) =>
    blobClient.stageBlockFromURL(
      chunk.blockId,
      sourceUrl,
      chunk.start,
      chunk.size
    )
  );
  await Promise.all(responses);
  console.log(`Staged ${jobPlan.chunks.length} block(s)`);
  console.log(`Committing Block List`);
  await blobClient.commitBlockList(jobPlan.chunks.map((c) => c.blockId));
  console.log(`Committed Block List`);

  console.log(`Transloaded ${name}`);
  return { name, status: "complete", size: jobPlan.length };
}
