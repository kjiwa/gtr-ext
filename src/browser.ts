export interface ExtEvent<Args extends unknown[]> {
  addListener(listener: (...args: Args) => unknown): void;
}

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface DownloadItemInfo {
  id: number;
  url: string;
  finalUrl?: string;
  filename?: string;
}

export interface CookieInfo {
  name: string;
  value: string;
}

export interface NotificationOptions {
  type: "basic";
  iconUrl: string;
  title: string;
  message: string;
}

export interface ExtApi {
  storage: { local: StorageArea };
  downloads: {
    onCreated: ExtEvent<[DownloadItemInfo]>;
    cancel(downloadId: number): Promise<void>;
    erase(query: { id: number }): Promise<number[]>;
  };
  cookies: { getAll(details: { url: string }): Promise<CookieInfo[]> };
  notifications: { create(notificationId: string, options: NotificationOptions): Promise<string> };
  runtime: {
    onMessage: ExtEvent<[unknown]>;
    onStartup: ExtEvent<[]>;
    onInstalled: ExtEvent<[]>;
    getPlatformInfo(): Promise<unknown>;
    getURL(path: string): string;
  };
}

export interface StorageChange {
  newValue?: unknown;
}

export interface UiApi {
  storage: {
    local: StorageArea;
    onChanged: ExtEvent<[Record<string, StorageChange>, string]>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    openOptionsPage(): Promise<void>;
  };
  permissions: {
    contains(request: { origins: string[] }): Promise<boolean>;
    request(request: { origins: string[] }): Promise<boolean>;
  };
}

const scope = globalThis as unknown as { browser?: ExtApi; chrome?: ExtApi };

// Absent outside an extension context (unit tests inject a fake instead).
export const ext = (scope.browser ?? scope.chrome) as ExtApi;

const uiScope = globalThis as unknown as { browser?: UiApi; chrome?: UiApi };

export const uiExt = (uiScope.browser ?? uiScope.chrome) as UiApi;
