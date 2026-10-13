export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  extraStatuses?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const DEFAULT_RETRIES = 8;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryableStatus(status: number, extraStatuses: readonly number[]): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599) || extraStatuses.includes(status);
}

// Equal jitter: half the exponential delay is fixed, half is random.
function backoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return ceiling / 2 + (random() * ceiling) / 2;
}

function retryAfterMs(response: Response, now: () => number): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  const delay = header.trim() !== "" && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
  return Number.isNaN(delay) ? undefined : Math.min(Math.max(delay, 0), MAX_RETRY_AFTER_MS);
}

export function retrying(fetchFn: FetchFn, options: RetryOptions = {}): FetchFn {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const extraStatuses = options.extraStatuses ?? [];
  const wait = options.sleep ?? sleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  return async (url, init) => {
    const signal = init?.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchFn(url, init);
      } catch (error) {
        if (!(error instanceof TypeError) || signal?.aborted || attempt >= retries) {
          throw error;
        }
        await wait(backoffMs(attempt, baseDelayMs, maxDelayMs, random), signal);
        continue;
      }
      if (!isRetryableStatus(response.status, extraStatuses) || attempt >= retries || signal?.aborted) {
        return response;
      }
      const delay = retryAfterMs(response, now) ?? backoffMs(attempt, baseDelayMs, maxDelayMs, random);
      await response.body?.cancel();
      await wait(delay, signal);
    }
  };
}
