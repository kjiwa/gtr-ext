import { describe, expect, it } from "vitest";
import { createBackground, type BackgroundDeps } from "../src/background";
import { TransloadError, type TransloadOptions, type TransloadResult } from "../src/transload";
import { INTERRUPTED_MESSAGE, TRANSFERS_KEY, type Transfer } from "../src/transfers";
import { fakeExt, type FakeExt } from "./fake-ext";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const SAS = "https://gtrtest.blob.core.windows.net/takeouts?sp=racw&se=2026-01-02T00%3A00%3A00Z&sig=SIG%3D";
const READY = { enabled: true, proxyBase: "https://proxy.example.com", secret: "s3cret", sasUrl: SAS };
const TAKEOUT = "https://takeout.google.com/takeout/download?j=abc";

type TransloadFn = BackgroundDeps["transload"];
type Job = Parameters<TransloadFn>[1];

interface Harness {
  fake: FakeExt;
  bg: ReturnType<typeof createBackground>;
  clock: { now: number };
  intervals: { callback: () => void; ms: number; cleared: boolean }[];
  transfers: () => Record<string, Transfer>;
}

function harness(transloadFn: TransloadFn, initial: Record<string, unknown> = { ...READY }): Harness {
  const fake = fakeExt(initial);
  const clock = { now: NOW };
  const intervals: Harness["intervals"] = [];
  let counter = 0;
  const bg = createBackground({
    ext: fake.api,
    transload: transloadFn,
    now: () => clock.now,
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms, cleared: false });
      return intervals.length - 1;
    },
    clearInterval: (handle) => {
      intervals[handle as number]!.cleared = true;
    },
    randomId: () => `t${(counter += 1)}`,
  });
  return { fake, bg, clock, intervals, transfers: () => (fake.store[TRANSFERS_KEY] ?? {}) as Record<string, Transfer> };
}

const RESULT: TransloadResult = { bytes: 2048, blocks: 1, durationMs: 2000 };

function succeeding(disposition: string | null = 'attachment; filename="real.zip"'): TransloadFn {
  return async (_config, job: Job, options: TransloadOptions = {}) => {
    const name = typeof job.blobName === "function" ? job.blobName(disposition) : job.blobName;
    expect(name).toBeTruthy();
    options.onProgress?.(0, 2048);
    options.onProgress?.(2048, 2048);
    return RESULT;
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

describe("interception", () => {
  it("ignores non-Takeout downloads without cancelling them", async () => {
    let called = false;
    const { fake, bg } = harness(async () => {
      called = true;
      return RESULT;
    });
    await bg.onCreated({ id: 1, url: "https://example.com/file.zip" });
    expect(called).toBe(false);
    expect(fake.cancelled).toEqual([]);
    expect(fake.erased).toEqual([]);
    expect(fake.notices).toEqual([]);
  });

  it("ignores everything while disabled", async () => {
    const { fake, bg } = harness(succeeding(), { ...READY, enabled: false });
    await bg.onCreated({ id: 1, url: TAKEOUT });
    expect(fake.cancelled).toEqual([]);
    expect(fake.notices).toEqual([]);
  });

  it("matches on finalUrl before url", async () => {
    const { fake, bg } = harness(succeeding());
    await bg.onCreated({ id: 1, url: "https://example.com/redirect", finalUrl: TAKEOUT });
    expect(fake.cancelled).toEqual([1]);
  });

  it("does not cancel and warns once a minute when setup is incomplete", async () => {
    const { fake, bg, clock } = harness(succeeding(), { ...READY, secret: "" });
    await bg.onCreated({ id: 1, url: TAKEOUT });
    await bg.onCreated({ id: 2, url: TAKEOUT });
    expect(fake.cancelled).toEqual([]);
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]?.message).toBe("GTR is on but setup is incomplete. Open the extension settings.");
    clock.now += 60_000;
    await bg.onCreated({ id: 3, url: TAKEOUT });
    expect(fake.notices).toHaveLength(2);
  });
});

describe("transfers", () => {
  it("cancels and erases the download, then records a successful copy with an updated notification", async () => {
    const seen: { job?: Job } = {};
    const inner = succeeding();
    const { fake, bg, transfers } = harness(async (config, job, options) => {
      seen.job = job;
      return inner(config, job, options);
    });
    fake.cookies = [
      { name: "SID", value: "1" },
      { name: "NID", value: "huge" },
      { name: "HSID", value: "2" },
    ];
    await bg.onCreated({ id: 7, url: TAKEOUT, filename: "/dl/takeout-001.zip" });
    expect(fake.cancelled).toEqual([7]);
    expect(fake.erased).toEqual([7]);
    expect(fake.cookieUrls).toEqual([TAKEOUT]);
    expect(seen.job).toMatchObject({ takeoutUrl: TAKEOUT, cookie: "SID=1; HSID=2" });
    expect(transfers()["t1"]).toMatchObject({ id: "t1", name: "real.zip", phase: "done", bytesDone: 2048, bytesTotal: 2048, finishedAt: NOW });
    expect(fake.notices.map((notice) => notice.id)).toEqual(["gtr-t1", "gtr-t1"]);
    expect(fake.notices[0]?.message).toBe("Copying takeout-001.zip to Azure.");
    expect(fake.notices[1]).toMatchObject({ title: "Takeout transfer complete", message: "real.zip: 2.0 KiB in 2 s (1.0 KiB/s)", iconUrl: "chrome-extension://fake/logo192.png" });
  });

  it("passes through intermediate phases", async () => {
    const phases: string[] = [];
    const gate = deferred();
    const { bg, transfers } = harness(async (_config, job, options) => {
      if (typeof job.blobName === "function") {
        job.blobName(null);
      }
      options?.onProgress?.(0, 100);
      await until(() => transfers()["t1"]?.phase === "copying");
      phases.push(transfers()["t1"]!.phase);
      options?.onProgress?.(100, 100);
      await until(() => transfers()["t1"]?.phase === "committing");
      phases.push(transfers()["t1"]!.phase);
      gate.resolve();
      return RESULT;
    });
    await bg.onCreated({ id: 1, url: TAKEOUT });
    await gate.promise;
    expect(phases).toEqual(["copying", "committing"]);
    expect(transfers()["t1"]?.phase).toBe("done");
  });

  it("records the user-actionable message when the copy fails", async () => {
    const message = "The Takeout cookie is too large to fit in Azure's 2 KiB copy-source limit. Sign out of Google accounts you do not need, then start the download again.";
    const { fake, bg, transfers } = harness(async () => {
      throw new TransloadError("ticket_too_long", message);
    });
    await bg.onCreated({ id: 1, url: TAKEOUT, filename: "a.zip" });
    expect(transfers()["t1"]).toMatchObject({ phase: "failed", error: { code: "ticket_too_long", message } });
    expect(fake.notices.at(-1)).toMatchObject({ title: "Takeout transfer failed", message: `a.zip: ${message}` });
  });

  it("hides unexpected error details", async () => {
    const { fake, bg, transfers } = harness(async () => {
      throw new Error("secret https://leak.example/?sig=1");
    });
    await bg.onCreated({ id: 1, url: TAKEOUT, filename: "a.zip" });
    expect(transfers()["t1"]?.phase).toBe("failed");
    expect(JSON.stringify([transfers(), fake.notices])).not.toContain("leak");
  });

  it("aborts the matching transfer on a cancel message", async () => {
    const started = deferred();
    const { fake, bg, transfers } = harness(async (_config, _job, options) => {
      started.resolve();
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
      throw new TransloadError("aborted", "The transfer was cancelled.");
    });
    const running = bg.onCreated({ id: 1, url: TAKEOUT, filename: "a.zip" });
    await started.promise;
    bg.onMessage({ type: "cancel", id: "other" });
    bg.onMessage({ type: "status" });
    expect(transfers()["t1"]?.phase).toBe("starting");
    bg.onMessage({ type: "cancel", id: "t1" });
    await running;
    expect(transfers()["t1"]).toMatchObject({ phase: "cancelled", error: { code: "aborted" } });
    expect(fake.notices.at(-1)?.title).toBe("Takeout transfer cancelled");
  });

  it("clears finished transfers on request without touching active ones", async () => {
    const started = deferred();
    const release = deferred();
    const old: Transfer = { id: "old", name: "old.zip", phase: "done", bytesDone: 1, bytesTotal: 1, startedAt: 1 };
    const { bg, transfers } = harness(
      async () => {
        started.resolve();
        await release.promise;
        return RESULT;
      },
      { ...READY, [TRANSFERS_KEY]: { old } },
    );
    const running = bg.onCreated({ id: 1, url: TAKEOUT, filename: "a.zip" });
    await started.promise;
    bg.onMessage({ type: "clearFinished" });
    await until(() => !("old" in transfers()));
    expect(Object.keys(transfers())).toEqual(["t1"]);
    release.resolve();
    await running;
    expect(transfers()["t1"]?.phase).toBe("done");
  });

  it("records two concurrent downloads independently", async () => {
    const gates = [deferred(), deferred()];
    let next = 0;
    const { bg, transfers } = harness(async () => {
      const gate = gates[next++]!;
      await gate.promise;
      return RESULT;
    });
    const first = bg.onCreated({ id: 1, url: TAKEOUT, filename: "a.zip" });
    const second = bg.onCreated({ id: 2, url: `${TAKEOUT}&x=1`, filename: "b.zip" });
    await until(() => next === 2 && Object.keys(transfers()).length === 2);
    gates.forEach((gate) => gate.resolve());
    await Promise.all([first, second]);
    expect(
      Object.values(transfers())
        .map((transfer) => [transfer.name, transfer.phase])
        .sort(),
    ).toEqual([
      ["a.zip", "done"],
      ["b.zip", "done"],
    ]);
  });
});

describe("restart recovery", () => {
  it("marks stale transfers interrupted before handling a new event", async () => {
    const stale: Record<string, Transfer> = { old: { id: "old", name: "old.zip", phase: "copying", bytesDone: 1, bytesTotal: 2, startedAt: 1 } };
    const { bg, transfers } = harness(succeeding(), { ...READY, enabled: false, [TRANSFERS_KEY]: stale });
    await bg.onCreated({ id: 1, url: "https://example.com/x" });
    expect(transfers()["old"]).toMatchObject({ phase: "interrupted", error: { message: INTERRUPTED_MESSAGE } });
  });

  it("also recovers on startup and install events", async () => {
    const stale: Record<string, Transfer> = { old: { id: "old", name: "old.zip", phase: "starting", bytesDone: 0, bytesTotal: 0, startedAt: 1 } };
    const { bg, transfers } = harness(succeeding(), { ...READY, [TRANSFERS_KEY]: stale });
    await bg.onWake();
    expect(transfers()["old"]?.phase).toBe("interrupted");
  });
});

describe("keepalive", () => {
  it("polls getPlatformInfo every 20 s while a transfer is active and stops afterwards", async () => {
    const gates = [deferred(), deferred()];
    let next = 0;
    const { fake, bg, intervals } = harness(async () => {
      await gates[next++]!.promise;
      return RESULT;
    });
    expect(intervals).toHaveLength(0);
    const first = bg.onCreated({ id: 1, url: TAKEOUT });
    const second = bg.onCreated({ id: 2, url: `${TAKEOUT}&x=1` });
    await until(() => next === 2);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.ms).toBe(20_000);
    intervals[0]!.callback();
    expect(fake.platformInfoCalls.count).toBe(1);
    gates[0]!.resolve();
    await first;
    expect(intervals[0]?.cleared).toBe(false);
    gates[1]!.resolve();
    await second;
    expect(intervals[0]?.cleared).toBe(true);
  });
});
