const RELAY_PREFIX = "/azure/";
const BLOB_HOST_SUFFIX = ".blob.core.windows.net";
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;

// Pathname and query are carried verbatim so percent-escapes in blob names and SAS signatures survive.
export function sasUrlToRelayPath(sasUrl: string): string {
  const url = new URL(sasUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(BLOB_HOST_SUFFIX)) {
    throw new Error("not an Azure blob URL");
  }
  const account = url.hostname.slice(0, -BLOB_HOST_SUFFIX.length);
  if (!ACCOUNT_NAME.test(account)) {
    throw new Error("invalid storage account name");
  }
  return `${RELAY_PREFIX}${account}${url.pathname}${url.search}`;
}

function encodeQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function encodeBlobName(blobName: string): string {
  return blobName.split("/").map(encodeURIComponent).join("/");
}

// The container SAS query is carried verbatim; extraQuery values are percent-encoded.
export function buildRelayUrl(proxyBase: string, containerSasUrl: string, blobName: string, extraQuery: Record<string, string> = {}): string {
  const relayPath = sasUrlToRelayPath(containerSasUrl);
  const queryStart = relayPath.indexOf("?");
  const containerPath = (queryStart === -1 ? relayPath : relayPath.slice(0, queryStart)).replace(/\/+$/, "");
  const query = [queryStart === -1 ? "" : relayPath.slice(queryStart + 1), encodeQuery(extraQuery)].filter(Boolean).join("&");
  return `${proxyBase}${containerPath}/${encodeBlobName(blobName)}${query ? `?${query}` : ""}`;
}
