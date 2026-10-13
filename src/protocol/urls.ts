const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function normalizeProxyBase(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("proxy URL is not a valid URL");
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname));
  if (!secure) {
    throw new Error("proxy URL must use https");
  }
  if (url.username !== "" || url.password !== "" || /[?#]/.test(trimmed)) {
    throw new Error("proxy URL must not contain credentials, a query or a fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function ticketUrl(proxyBase: string, ticket: string): string {
  return `${proxyBase}/t/${ticket}`;
}
