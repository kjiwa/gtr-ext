const BLOB_HOST_SUFFIX = ".blob.core.windows.net";
const CONTAINER_PATH = /^\/([^/]+)\/?$/;

export type SasErrorCode = "invalid_url" | "not_https" | "bad_host" | "not_container" | "missing_signature" | "missing_permissions" | "expired";

export class SasError extends Error {
  constructor(
    readonly code: SasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SasError";
  }
}

export interface ContainerSas {
  account: string;
  container: string;
  expiresAt?: number;
  permissions?: string;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new SasError("invalid_url", "The SAS URL is not a valid URL.");
  }
}

function parseAccount(url: URL): string {
  if (url.protocol !== "https:") {
    throw new SasError("not_https", "The SAS URL must use https.");
  }
  if (!url.hostname.endsWith(BLOB_HOST_SUFFIX) || url.hostname.length === BLOB_HOST_SUFFIX.length) {
    throw new SasError("bad_host", "The SAS URL host must be <account>.blob.core.windows.net.");
  }
  return url.hostname.slice(0, -BLOB_HOST_SUFFIX.length);
}

function parseContainer(url: URL): string {
  const match = CONTAINER_PATH.exec(url.pathname);
  if (!match) {
    throw new SasError("not_container", "The SAS URL must be a container-level SAS, not a blob-level or account-level SAS.");
  }
  return match[1]!;
}

function requireWritePermission(permissions: string | undefined): void {
  if (permissions !== undefined && !/[wc]/.test(permissions)) {
    throw new SasError("missing_permissions", "The SAS URL needs write (w) or create (c) permission.");
  }
}

function parseExpiry(value: string | null, now: number): number | undefined {
  if (value === null) {
    return undefined;
  }
  const expiresAt = Date.parse(value);
  if (Number.isNaN(expiresAt)) {
    throw new SasError("invalid_url", "The SAS URL has an unreadable expiry (se).");
  }
  if (expiresAt <= now) {
    throw new SasError("expired", "The SAS URL has expired. Generate a new one.");
  }
  return expiresAt;
}

export function parseContainerSas(sasUrl: string, now: number = Date.now()): ContainerSas {
  const url = parseUrl(sasUrl);
  const account = parseAccount(url);
  const container = parseContainer(url);
  if (!url.searchParams.get("sig")) {
    throw new SasError("missing_signature", "The SAS URL has no signature (sig).");
  }
  const permissions = url.searchParams.get("sp") ?? undefined;
  requireWritePermission(permissions);
  const expiresAt = parseExpiry(url.searchParams.get("se"), now);
  return { account, container, ...(expiresAt === undefined ? {} : { expiresAt }), ...(permissions === undefined ? {} : { permissions }) };
}
