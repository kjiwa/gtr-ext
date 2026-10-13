import { describe, expect, it, vi } from "vitest";
import { retrying, type FetchFn } from "../src/retry";

function sequence(...steps: (Response | Error)[]): { fetchFn: FetchFn; calls: () => number } {
  let calls = 0;
  const fetchFn: FetchFn = async () => {
    const step = steps[Math.min(calls++, steps.length - 1)]!;
    if (step instanceof Error) {
      throw step;
    }
    return step.clone();
  };
  return { fetchFn, calls: () => calls };
}

const respond = (status: number, headers?: Record<string, string>): Response => new Response(null, { status, ...(headers && { headers }) });

function setup(options: Parameters<typeof retrying>[1] = {}) {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { delays, options: { sleep, random: () => 1, ...options } };
}

describe("retrying", () => {
  it("returns a successful response without retrying", async () => {
    const { fetchFn, calls } = sequence(respond(200));
    const { options } = setup();
    expect((await retrying(fetchFn, options)("u")).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("retries 503 then succeeds", async () => {
    const { fetchFn, calls } = sequence(respond(503), respond(503), respond(200));
    const { options, delays } = setup();
    expect((await retrying(fetchFn, options)("u")).status).toBe(200);
    expect(calls()).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it.each([408, 429, 500, 502, 520, 524, 599])("retries status %i", async (status) => {
    const { fetchFn, calls } = sequence(respond(status), respond(200));
    expect((await retrying(fetchFn, setup().options)("u")).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it.each([200, 201, 400, 401, 403, 404, 409, 410, 416])("does not retry status %i", async (status) => {
    const { fetchFn, calls } = sequence(respond(status));
    expect((await retrying(fetchFn, setup().options)("u")).status).toBe(status);
    expect(calls()).toBe(1);
  });

  it("retries 409 only when asked", async () => {
    const { fetchFn, calls } = sequence(respond(409), respond(201));
    expect((await retrying(fetchFn, setup({ extraStatuses: [409] }).options)("u")).status).toBe(201);
    expect(calls()).toBe(2);
  });

  it("retries network errors", async () => {
    const { fetchFn, calls } = sequence(new TypeError("fetch failed"), respond(200));
    expect((await retrying(fetchFn, setup().options)("u")).status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("does not retry other errors", async () => {
    const { fetchFn, calls } = sequence(new RangeError("bad"));
    await expect(retrying(fetchFn, setup().options)("u")).rejects.toThrow("bad");
    expect(calls()).toBe(1);
  });

  it("gives up after the retry budget and returns the last response", async () => {
    const { fetchFn, calls } = sequence(respond(503));
    const { options } = setup({ retries: 3 });
    expect((await retrying(fetchFn, options)("u")).status).toBe(503);
    expect(calls()).toBe(4);
  });

  it("rethrows the network error when the budget is exhausted", async () => {
    const { fetchFn, calls } = sequence(new TypeError("down"));
    await expect(retrying(fetchFn, setup({ retries: 2 }).options)("u")).rejects.toThrow("down");
    expect(calls()).toBe(3);
  });

  it("caps backoff at the maximum delay", async () => {
    const { fetchFn } = sequence(respond(503));
    const { options, delays } = setup({ retries: 8 });
    await retrying(fetchFn, options)("u");
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("applies jitter between half and the full delay", async () => {
    const { fetchFn } = sequence(respond(503), respond(200));
    const { options, delays } = setup({ random: () => 0 });
    await retrying(fetchFn, options)("u");
    expect(delays).toEqual([500]);
  });

  it("honors Retry-After in seconds and as a date", async () => {
    const { fetchFn } = sequence(respond(429, { "retry-after": "7" }), respond(503, { "retry-after": new Date(1_010_000).toUTCString() }), respond(200));
    const { options, delays } = setup({ now: () => 1_000_000 });
    await retrying(fetchFn, options)("u");
    expect(delays).toEqual([7000, 10000]);
  });

  it("does not retry once the signal is aborted", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = sequence(respond(503), respond(200));
    const sleep = vi.fn(async () => undefined);
    controller.abort();
    expect((await retrying(fetchFn, { sleep })("u", { signal: controller.signal })).status).toBe(503);
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a network error after abort", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = sequence(new TypeError("aborted"));
    controller.abort();
    await expect(retrying(fetchFn, setup().options)("u", { signal: controller.signal })).rejects.toThrow("aborted");
    expect(calls()).toBe(1);
  });

  it("stops waiting when aborted during backoff", async () => {
    const controller = new AbortController();
    const { fetchFn, calls } = sequence(respond(503), respond(200));
    const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
      controller.abort();
      throw signal?.reason;
    };
    await expect(retrying(fetchFn, { sleep })("u", { signal: controller.signal })).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });
});
