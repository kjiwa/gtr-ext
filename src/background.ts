/**
 * This is a background script
 * It is running in the background process of chrome
 * You can debug it by clicking the "background page"
 * button in the extension settings
 *
 */

import { sourceToGtrProxySource, transload } from "./transload";
import { Download } from "./state";
import prettyBytes from "pretty-bytes";
import pako from "pako";

console.log("initialized gtr extension");

function getConfig(): Promise<[boolean, string, string, string]> {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    chrome.storage.local.get(
      ["enabled", "azureSasUrl", "proxyBaseUrl", "proxyAuthToken"],
      (result) => {
        // Pass any observed errors down the promise chain.
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        const enabled = result.enabled as boolean;
        const azureSasUrl = result.azureSasUrl as string;
        const proxyBaseUrl = result.proxyBaseUrl as string;
        const proxyAuthToken = result.proxyAuthToken as string;
        resolve([enabled, azureSasUrl, proxyBaseUrl, proxyAuthToken]);
      }
    );
  });
}

// A tiny async mutex used to serialize reads and writes of the "downloads"
// entry in chrome.storage.local. Concurrent transloads (e.g. several
// archives downloading in parallel) would otherwise race on a
// get-modify-set cycle and silently clobber each other's updates.
let downloadsLock: Promise<unknown> = Promise.resolve();

function withDownloadsLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = downloadsLock.then(fn, fn);
  // Swallow errors here so a failed update doesn't permanently jam the
  // lock for subsequent callers; callers still observe rejections via the
  // returned promise.
  downloadsLock = result.catch(() => undefined);
  return result;
}

function getDownloads(): Promise<{ [key: string]: Download }> {
  // Immediately return a promise and start asynchronous work
  return new Promise((resolve, reject) => {
    // Asynchronously fetch all data from storage.sync.
    chrome.storage.local.get("downloads", (result) => {
      // Pass any observed errors down the promise chain.
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      const state = result.downloads as { [key: string]: Download };
      resolve(state);
    });
  });
}

export function getEncodedCookies(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll({ url }, (cookies) => {
      if (chrome.runtime.lastError) {
        return reject(chrome.runtime.lastError);
      }
      // Skip NID cookie since it is very large and not needed for Google Takeout requests.
      const filteredCookies = cookies.filter((cookie) => cookie.name !== "NID");
      const cookieString = filteredCookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      const compressedData = pako.gzip(cookieString);
      const b64encoded_string = btoa(
        String.fromCharCode(...new Uint8Array(compressedData))
      );
      resolve(b64encoded_string);
    });
  });
}

async function captureDownload(
  downloadItem: chrome.downloads.DownloadItem,
  suggestion: Function
) {
  const [enabled, azureSasUrl, proxyBaseUrl, proxyAuthToken] =
    await getConfig();
  if (!enabled) {
    console.log("Skipping interception of download.");
    return;
  }

  console.log("download started, filename:", downloadItem.filename);
  chrome.notifications.create(`transload-start-${downloadItem.filename}`, {
    title: "🚀 GTR Transload Started",
    message: `⏳ ${downloadItem.filename} started (disable interception in extension popup)`,
    type: "basic",
    iconUrl: "/logo512.png",
    priority: 0
  });
  chrome.downloads.cancel(downloadItem.id);
  console.log("chrome native download cancelled");
  // Note: azureSasUrl carries a credential (an Azure SAS token) and must
  // never be logged.
  const sas = azureSasUrl;

  // Add download to pending
  const pendingDownload: Download = {
    name: downloadItem.filename,
    status: "pending"
  };
  await withDownloadsLock(async () => {
    const preDownloadsState = await getDownloads();
    await chrome.storage.local.set({
      downloads: {
        ...preDownloadsState,
        [pendingDownload.name]: pendingDownload
      }
    });
  });

  let download: Download;
  let prettySpeed: string = "";
  try {
    const now = new Date();

    // gzip + base64 encode cookies
    const encodedCookies = await getEncodedCookies(downloadItem.finalUrl);

    download = await transload(
      sourceToGtrProxySource(
        downloadItem.finalUrl,
        proxyBaseUrl,
        encodedCookies,
        proxyAuthToken
      ),
      sas,
      downloadItem.filename,
      proxyBaseUrl,
      undefined,
      proxyAuthToken
    );
    const then = new Date();
    const duration = then.getTime() - now.getTime();
    if (download.size) {
      prettySpeed = `${prettyBytes(download.size)} @ ${prettyBytes(
        (download.size / duration) * 1000
      )}/s`;
    }
    download["reason"] = prettySpeed;
  } catch (err) {
    download = {
      name: downloadItem.filename,
      status: "failed"
    };
    if (err instanceof Error) {
      download["reason"] = err.message;
    }
  }

  await withDownloadsLock(async () => {
    const updateDownloadsState = await getDownloads();
    await chrome.storage.local.set({
      downloads: {
        ...updateDownloadsState,
        [download.name]: download
      }
    });
  });
  chrome.notifications.clear(`transload-start-${downloadItem.filename}`);
  if (download.status === "complete") {
    chrome.notifications.create(`transload-complete-${downloadItem.filename}`, {
      title: "🚀 GTR Transload Complete",
      message: `✅ ${downloadItem.filename} complete (${prettySpeed}) (disable interception in extension popup)`,
      type: "basic",
      iconUrl: "/logo512.png",
      priority: 0
    });
  } else {
    chrome.notifications.create(`transload-failed-${downloadItem.filename}`, {
      title: "🚀 GTR Transload Failed",
      message: `❌ ${downloadItem.filename} failed (disable interception in extension popup)`,
      type: "basic",
      iconUrl: "/logo512.png",
      priority: 0
    });
  }
  console.log("Transload complete");
}

//  Stop all the downloading
chrome.downloads.onDeterminingFilename.addListener(captureDownload);
