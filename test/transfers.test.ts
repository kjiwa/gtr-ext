import { describe, expect, it } from "vitest";
import { INTERRUPTED_MESSAGE, TransferStore, TRANSFERS_KEY, type Transfer } from "../src/transfers";
import { fakeExt } from "./fake-ext";

function setup(initial: Record<string, unknown> = {}): { store: TransferStore; raw: () => Record<string, Transfer>; clock: { now: number } } {
  const fake = fakeExt(initial);
  const clock = { now: 1_000_000 };
  return { store: new TransferStore(fake.api.storage.local, () => clock.now), raw: () => (fake.store[TRANSFERS_KEY] ?? {}) as Record<string, Transfer>, clock };
}

describe("TransferStore", () => {
  it("creates a starting transfer", async () => {
    const { store, raw } = setup();
    await store.create("a", "a.zip");
    expect(raw()["a"]).toEqual({ id: "a", name: "a.zip", phase: "starting", bytesDone: 0, bytesTotal: 0, startedAt: 1_000_000 });
  });

  it("keeps every entry when creates and updates run concurrently", async () => {
    const { store, raw } = setup();
    const ids = Array.from({ length: 20 }, (_, index) => `t${index}`);
    await Promise.all(ids.map((id) => store.create(id, `${id}.zip`)));
    await Promise.all(ids.map((id) => store.update(id, { phase: "copying", bytesDone: 5, bytesTotal: 10 })));
    expect(Object.keys(raw())).toHaveLength(20);
    expect(Object.values(raw()).every((transfer) => transfer.phase === "copying" && transfer.bytesDone === 5)).toBe(true);
  });

  it("writes phase changes immediately but throttles progress to one write per second", async () => {
    const { store, raw, clock } = setup();
    await store.create("a", "a.zip");
    await store.update("a", { phase: "copying", bytesDone: 0, bytesTotal: 100 });
    await store.update("a", { bytesDone: 10 });
    expect(raw()["a"]?.bytesDone).toBe(0);
    clock.now += 1000;
    await store.update("a", { bytesDone: 20 });
    expect(raw()["a"]?.bytesDone).toBe(20);
    await store.update("a", { phase: "committing", bytesDone: 100 });
    expect(raw()["a"]).toMatchObject({ phase: "committing", bytesDone: 100 });
  });

  it("throttles each transfer independently", async () => {
    const { store, raw } = setup();
    await store.create("a", "a.zip");
    await store.create("b", "b.zip");
    await store.update("a", { phase: "copying", bytesDone: 1 });
    await store.update("b", { bytesDone: 7 });
    expect(raw()["b"]?.bytesDone).toBe(0);
  });

  it("finishes with a phase, timestamp and error, and ignores later updates", async () => {
    const { store, raw, clock } = setup();
    await store.create("a", "a.zip");
    clock.now += 5000;
    await store.finish("a", "failed", { error: { code: "x", message: "boom" } });
    await store.update("a", { phase: "copying" });
    expect(raw()["a"]).toMatchObject({ phase: "failed", finishedAt: 1_005_000, error: { code: "x", message: "boom" } });
  });

  it("clearFinished removes terminal transfers and keeps active ones", async () => {
    const { store, raw } = setup();
    for (const id of ["a", "b", "c", "d"]) {
      await store.create(id, id);
    }
    await store.update("b", { phase: "copying" });
    await store.finish("a", "done");
    await store.finish("c", "cancelled");
    await store.clearFinished();
    expect(Object.keys(raw()).sort()).toEqual(["b", "d"]);
  });

  it("markInterrupted turns every non-terminal transfer into interrupted with guidance", async () => {
    const { store, raw } = setup();
    for (const id of ["a", "b", "c"]) {
      await store.create(id, id);
    }
    await store.update("b", { phase: "committing" });
    await store.finish("c", "done");
    await store.markInterrupted();
    expect(raw()["a"]).toMatchObject({ phase: "interrupted", error: { code: "interrupted", message: INTERRUPTED_MESSAGE } });
    expect(raw()["b"]?.phase).toBe("interrupted");
    expect(raw()["c"]?.phase).toBe("done");
  });

  it("lists newest first", async () => {
    const { store, clock } = setup();
    await store.create("old", "old");
    clock.now += 10;
    await store.create("new", "new");
    expect((await store.list()).map((transfer) => transfer.id)).toEqual(["new", "old"]);
  });
});
