import { ext, type DownloadItemInfo, type ExtApi } from "./browser";
import { formatBytes } from "./ui/format";
import { isReady, loadConfig, type Config } from "./config";
import { resolveFilename } from "./filename";
import { isTakeoutUrl } from "./protocol/takeout";
import { transload, TransloadError, type TransloadResult } from "./transload";
import { TransferStore, type TransferPatch } from "./transfers";

export interface BackgroundDeps {
  ext: ExtApi;
  transload: typeof transload;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  randomId: () => string;
}

const KEEPALIVE_MS = 20_000;
const SETUP_NOTICE_INTERVAL_MS = 60_000;
const SETUP_NOTICE_ID = "gtr-setup";
const ICON_PATH = "logo192.png";

interface TransferState {
  name: string;
  copying: boolean;
}

function summarize(result: TransloadResult): string {
  const seconds = Math.max(result.durationMs / 1000, 0.001);
  return `${formatBytes(result.bytes)} in ${Math.round(seconds)} s (${formatBytes(result.bytes / seconds)}/s)`;
}

function toTransloadError(error: unknown): TransloadError {
  return error instanceof TransloadError ? error : new TransloadError("protocol_error", "The transfer failed unexpectedly. Start the download again in Google Takeout.");
}

function isCancelMessage(message: unknown): message is { type: "cancel"; id: string } {
  const candidate = message as { type?: unknown; id?: unknown } | null;
  return candidate?.type === "cancel" && typeof candidate.id === "string";
}

function isClearFinishedMessage(message: unknown): boolean {
  return (message as { type?: unknown } | null)?.type === "clearFinished";
}

export function createBackground(deps: BackgroundDeps) {
  const { ext: api } = deps;
  const store = new TransferStore(api.storage.local, deps.now);
  const controllers = new Map<string, AbortController>();
  let keepalive: unknown;
  let lastSetupNotice = -Infinity;

  // A restarted worker has lost its in-flight copies, so earlier entries are stale before any event is handled.
  const ready = store.markInterrupted().catch(() => undefined);

  function startKeepalive(): void {
    keepalive ??= deps.setInterval(() => void api.runtime.getPlatformInfo().catch(() => undefined), KEEPALIVE_MS);
  }

  function stopKeepaliveIfIdle(): void {
    if (controllers.size === 0 && keepalive !== undefined) {
      deps.clearInterval(keepalive);
      keepalive = undefined;
    }
  }

  async function notify(id: string, title: string, message: string): Promise<void> {
    await api.notifications.create(id, { type: "basic", iconUrl: api.runtime.getURL(ICON_PATH), title, message }).catch(() => undefined);
  }

  async function notifyIncompleteSetup(): Promise<void> {
    const at = deps.now();
    if (at - lastSetupNotice < SETUP_NOTICE_INTERVAL_MS) {
      return;
    }
    lastSetupNotice = at;
    await notify(SETUP_NOTICE_ID, "Takeout transfer not started", "GTR is on but setup is incomplete. Open the extension settings.");
  }

  async function discardDownload(id: number): Promise<void> {
    await api.downloads.cancel(id).catch(() => undefined);
    await api.downloads.erase({ id }).catch(() => undefined);
  }

  // NID is large and not needed by Takeout; dropping it keeps the ticket within Azure's 2 KiB copy-source limit.
  async function cookieHeader(url: string): Promise<string> {
    const cookies = await api.cookies.getAll({ url });
    return cookies
      .filter((cookie) => cookie.name !== "NID")
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  function progressPatch(state: TransferState, bytesDone: number, bytesTotal: number): TransferPatch {
    if (!state.copying) {
      state.copying = true;
      return { phase: "copying", name: state.name, bytesDone, bytesTotal };
    }
    return bytesDone === bytesTotal ? { phase: "committing", bytesDone, bytesTotal } : { bytesDone, bytesTotal };
  }

  async function runTransfer(id: string, item: DownloadItemInfo, url: string, config: Config, state: TransferState, signal: AbortSignal): Promise<TransloadResult> {
    const cookie = await cookieHeader(url);
    const blobName = (contentDisposition: string | null): string => {
      state.name = resolveFilename({ contentDisposition, itemFilename: item.filename, url, now: deps.now() });
      return state.name;
    };
    const onProgress = (bytesDone: number, bytesTotal: number): void => {
      void store.update(id, progressPatch(state, bytesDone, bytesTotal)).catch(() => undefined);
    };
    return deps.transload({ proxyBase: config.proxyBase, secret: config.secret, containerSasUrl: config.sasUrl }, { takeoutUrl: url, cookie, blobName }, { signal, onProgress });
  }

  async function finishFailed(id: string, name: string, error: unknown): Promise<void> {
    const failure = toTransloadError(error);
    const details = { error: { code: failure.code, message: failure.message } };
    if (failure.code === "aborted") {
      await store.finish(id, "cancelled", details);
      await notify(`gtr-${id}`, "Takeout transfer cancelled", name);
      return;
    }
    await store.finish(id, "failed", details);
    await notify(`gtr-${id}`, "Takeout transfer failed", `${name}: ${failure.message}`);
  }

  async function handleTakeoutDownload(item: DownloadItemInfo, url: string, config: Config): Promise<void> {
    await discardDownload(item.id);
    const id = deps.randomId();
    const state: TransferState = { name: resolveFilename({ contentDisposition: null, itemFilename: item.filename, url, now: deps.now() }), copying: false };
    const controller = new AbortController();
    controllers.set(id, controller);
    startKeepalive();
    try {
      await store.create(id, state.name);
      await notify(`gtr-${id}`, "Takeout transfer started", `Copying ${state.name} to Azure.`);
      const result = await runTransfer(id, item, url, config, state, controller.signal);
      await store.finish(id, "done", { name: state.name, bytesDone: result.bytes, bytesTotal: result.bytes });
      await notify(`gtr-${id}`, "Takeout transfer complete", `${state.name}: ${summarize(result)}`);
    } catch (error) {
      await finishFailed(id, state.name, error);
    } finally {
      controllers.delete(id);
      stopKeepaliveIfIdle();
    }
  }

  async function onCreated(item: DownloadItemInfo): Promise<void> {
    await ready;
    const config = await loadConfig(api);
    const url = item.finalUrl || item.url;
    if (!config.enabled || !isTakeoutUrl(url)) {
      return;
    }
    if (!isReady(config, deps.now())) {
      await notifyIncompleteSetup();
      return;
    }
    await handleTakeoutDownload(item, url, config);
  }

  function onMessage(message: unknown): void {
    if (isCancelMessage(message)) {
      controllers.get(message.id)?.abort();
    } else if (isClearFinishedMessage(message)) {
      void store.clearFinished();
    }
  }

  async function onWake(): Promise<void> {
    await ready;
  }

  return { onCreated, onMessage, onWake };
}

if (ext) {
  const background = createBackground({ ext, transload, now: Date.now, setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>), randomId: () => crypto.randomUUID() });
  ext.downloads.onCreated.addListener(background.onCreated);
  ext.runtime.onMessage.addListener(background.onMessage);
  ext.runtime.onStartup.addListener(background.onWake);
  ext.runtime.onInstalled.addListener(background.onWake);
}
