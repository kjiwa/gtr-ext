import type { StorageArea } from "./browser";

export type TransferPhase = "starting" | "copying" | "committing" | "done" | "failed" | "interrupted" | "cancelled";

export interface TransferError {
  code: string;
  message: string;
}

export interface Transfer {
  id: string;
  name: string;
  phase: TransferPhase;
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
  finishedAt?: number;
  error?: TransferError;
}

export type TransferPatch = Partial<Pick<Transfer, "name" | "phase" | "bytesDone" | "bytesTotal">>;
export type TerminalPhase = "done" | "failed" | "interrupted" | "cancelled";

export const TRANSFERS_KEY = "transfers";
export const INTERRUPTED_MESSAGE = "The browser or extension restarted during the copy. Start the download again in Google Takeout.";

const PROGRESS_INTERVAL_MS = 1000;
const TERMINAL_PHASES: ReadonlySet<TransferPhase> = new Set<TransferPhase>(["done", "failed", "interrupted", "cancelled"]);

export function isTerminal(phase: TransferPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

type Table = Record<string, Transfer>;

export class TransferStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly storage: StorageArea,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Promise<Transfer[]> {
    return this.enqueue(async () => Object.values(await this.read()).sort((a, b) => b.startedAt - a.startedAt));
  }

  create(id: string, name: string): Promise<void> {
    const startedAt = this.now();
    this.lastWrite.set(id, startedAt);
    return this.mutate((table) => {
      table[id] = { id, name, phase: "starting", bytesDone: 0, bytesTotal: 0, startedAt };
    });
  }

  // Patches without a phase are progress ticks, written at most once per second per transfer.
  async update(id: string, patch: TransferPatch): Promise<void> {
    const at = this.now();
    if (patch.phase === undefined && at - (this.lastWrite.get(id) ?? 0) < PROGRESS_INTERVAL_MS) {
      return;
    }
    this.lastWrite.set(id, at);
    await this.mutate((table) => {
      const transfer = table[id];
      if (transfer && !isTerminal(transfer.phase)) {
        Object.assign(transfer, patch);
      }
    });
  }

  async finish(id: string, phase: TerminalPhase, extra: TransferPatch & { error?: TransferError } = {}): Promise<void> {
    const finishedAt = this.now();
    this.lastWrite.delete(id);
    await this.mutate((table) => {
      const transfer = table[id];
      if (transfer) {
        Object.assign(transfer, { ...extra, phase, finishedAt });
      }
    });
  }

  clearFinished(): Promise<void> {
    return this.mutate((table) => {
      for (const [id, transfer] of Object.entries(table)) {
        if (isTerminal(transfer.phase)) {
          delete table[id];
        }
      }
    });
  }

  markInterrupted(): Promise<void> {
    const finishedAt = this.now();
    return this.mutate((table) => {
      for (const transfer of Object.values(table)) {
        if (!isTerminal(transfer.phase)) {
          Object.assign(transfer, { phase: "interrupted", finishedAt, error: { code: "interrupted", message: INTERRUPTED_MESSAGE } });
        }
      }
    });
  }

  private async read(): Promise<Table> {
    const stored = await this.storage.get(TRANSFERS_KEY);
    return (stored[TRANSFERS_KEY] as Table | undefined) ?? {};
  }

  private mutate(change: (table: Table) => void): Promise<void> {
    return this.enqueue(async () => {
      const table = await this.read();
      change(table);
      await this.storage.set({ [TRANSFERS_KEY]: table });
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
