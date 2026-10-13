import type { CookieInfo, DownloadItemInfo, ExtApi, ExtEvent, NotificationOptions } from "../src/browser";

export interface Notice extends NotificationOptions {
  id: string;
}

export interface FakeExt {
  api: ExtApi;
  store: Record<string, unknown>;
  cancelled: number[];
  erased: number[];
  notices: Notice[];
  platformInfoCalls: { count: number };
  cookies: CookieInfo[];
  cookieUrls: string[];
}

function fakeEvent<Args extends unknown[]>(): ExtEvent<Args> {
  return { addListener: () => undefined };
}

// Storage calls yield to the event loop so interleaved read-modify-write cycles would lose updates.
export function fakeExt(initial: Record<string, unknown> = {}): FakeExt {
  const fake: FakeExt = { api: undefined as unknown as ExtApi, store: { ...initial }, cancelled: [], erased: [], notices: [], platformInfoCalls: { count: 0 }, cookies: [], cookieUrls: [] };
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  fake.api = {
    storage: {
      local: {
        async get(keys) {
          await tick();
          const wanted = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(wanted.filter((key) => key in fake.store).map((key) => [key, structuredClone(fake.store[key])]));
        },
        async set(items) {
          await tick();
          Object.assign(fake.store, structuredClone(items));
        },
      },
    },
    downloads: {
      onCreated: fakeEvent<[DownloadItemInfo]>(),
      cancel: async (id) => void fake.cancelled.push(id),
      erase: async ({ id }) => {
        fake.erased.push(id);
        return [id];
      },
    },
    cookies: {
      getAll: async ({ url }) => {
        fake.cookieUrls.push(url);
        return fake.cookies;
      },
    },
    notifications: {
      create: async (id, options) => {
        fake.notices.push({ id, ...options });
        return id;
      },
    },
    runtime: {
      onMessage: fakeEvent<[unknown]>(),
      onStartup: fakeEvent<[]>(),
      onInstalled: fakeEvent<[]>(),
      getPlatformInfo: async () => {
        fake.platformInfoCalls.count += 1;
        return {};
      },
      getURL: (path) => `chrome-extension://fake/${path}`,
    },
  };
  return fake;
}
