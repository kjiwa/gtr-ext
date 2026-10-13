import { normalizeProxyBase } from "../protocol/urls";
import type { NoticeLevel } from "./sas-notice";

export type ConnectionOutcome = { kind: "response"; status: number; body: string } | { kind: "network" };

export interface ConnectionResult {
  level: NoticeLevel;
  text: string;
}

function parseVersion(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function describeSuccess(body: string): ConnectionResult {
  const version = parseVersion(body);
  if (version === undefined) {
    return { level: "danger", text: "The URL answered, but not like a GTR proxy (the response was not the expected JSON). Check that it points at your Worker." };
  }
  return { level: "ok", text: `Connected. Proxy version ${version}.` };
}

export function describeConnectionResult(outcome: ConnectionOutcome): ConnectionResult {
  if (outcome.kind === "network") {
    return { level: "danger", text: "Could not reach the proxy. Check the URL, your connection, and that access to the proxy is granted." };
  }
  if (outcome.status === 200) {
    return describeSuccess(outcome.body);
  }
  if (outcome.status === 401) {
    return { level: "danger", text: "The proxy rejected the secret (401). The secret here must match the one set on the Worker." };
  }
  if (outcome.status === 503) {
    return { level: "danger", text: "The Worker has no GTR_SECRET (503). Set it with npx wrangler secret put GTR_SECRET." };
  }
  return { level: "danger", text: `The proxy answered with HTTP ${outcome.status}. Check that the URL points at your Worker.` };
}

export async function testConnection(proxyBase: string, secret: string, fetchFn: typeof fetch = fetch): Promise<ConnectionResult> {
  const url = `${normalizeProxyBase(proxyBase)}/health`;
  try {
    const response = await fetchFn(url, { headers: { Authorization: `Bearer ${secret}` }, cache: "no-store" });
    return describeConnectionResult({ kind: "response", status: response.status, body: await response.text() });
  } catch {
    return describeConnectionResult({ kind: "network" });
  }
}

export function proxyOriginPattern(proxyBase: string): string {
  return `${new URL(normalizeProxyBase(proxyBase)).origin}/*`;
}
