import React, { useEffect, useState } from "react";
import { useChromeStorageLocal } from "use-chrome-storage";
import { Download } from "../state";
import { BUILT_IN_PROXY_BASE } from "../constants";

// Returns true if the given string is empty (allowed, since these fields
// are optional) or a well-formed, absolute URL.
function isValidOptionalUrl(value: string): boolean {
  if (!value) {
    return true;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export default function App() {
  const [enabled, setEnabled] = useChromeStorageLocal("enabled", false);
  const [proxyBaseUrl, setProxyBaseUrl] = useChromeStorageLocal(
    "proxyBaseUrl",
    BUILT_IN_PROXY_BASE
  );
  const [proxyAuthToken, setProxyAuthToken] = useChromeStorageLocal(
    "proxyAuthToken",
    ""
  );
  const [azureSasUrl, setAzureSasUrl] = useChromeStorageLocal(
    "azureSasUrl",
    ""
  );
  const [downloads, setDownloads] = useChromeStorageLocal<{
    [key: string]: Download;
  }>("downloads", {});

  const azureSasUrlValid = isValidOptionalUrl(azureSasUrl);
  const proxyBaseUrlValid = isValidOptionalUrl(proxyBaseUrl);
  const usingBuiltInProxy =
    !proxyBaseUrl || proxyBaseUrl === BUILT_IN_PROXY_BASE;

  return (
    <div>
      <h1>🚀 Gargantuan Takeout Helper</h1>
      <p>
        Gargantuan Takeout Rocket (GTR) is a toolkit of instructions/guides and
        software to help you transload your data from Google Takeout or similar
        services and put it into Azure safe easily, periodically, and fast.
      </p>
      <p>
        For a guide, please see{" "}
        <a href="https://github.com/nelsonjchen/gtr" target="_blank">
          https://github.com/nelsonjchen/gtr
        </a>
        .
      </p>
      <p>This is the extension part of the toolkit.</p>

      <form>
        <label htmlFor="enabled">Enable Download Interception:</label>
        <br />
        <input
          id="enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          style={{ zoom: 3.0 }}
        />
        <br />
        <label htmlFor="azureSasUrl">
          Azure SAS Container URL (Blob SAS URL):
        </label>
        <br />
        <input
          id="azureSasUrl"
          type="text"
          name="azureSasUrl"
          value={azureSasUrl}
          onChange={(e) => setAzureSasUrl(e.target.value)}
          style={{ width: "90%", zoom: 1.2 }}
        />
        {!azureSasUrlValid && (
          <p style={{ color: "red", margin: "4px 0" }}>
            This doesn&apos;t look like a valid URL.
          </p>
        )}
        <br />
        <br />
        <label htmlFor="proxyBaseUrl">
          GTR Proxy Base URL (default: {BUILT_IN_PROXY_BASE}):
          <a
            href="https://github.com/nelsonjchen/gtr-proxy#readme"
            target="_blank"
          >
            <br />
            Why is a GTR proxy needed? / I'm interested in using my own GTR
            Proxy.
          </a>
        </label>
        <br />
        <input
          id="proxyBaseUrl"
          type="text"
          name="proxyBaseUrl"
          value={proxyBaseUrl}
          onChange={(e) => setProxyBaseUrl(e.target.value)}
          style={{ width: "90%", zoom: 1.2 }}
        />
        {!proxyBaseUrlValid && (
          <p style={{ color: "red", margin: "4px 0" }}>
            This doesn&apos;t look like a valid URL.
          </p>
        )}
        {usingBuiltInProxy && (
          <p style={{ margin: "4px 0" }}>
            You&apos;re using the shared, publicly hosted default proxy. It can
            observe your Google cookies and Azure SAS token as it relays
            requests. For privacy, consider running your own instance (see the
            link above) and set a Proxy Auth Token below to prevent others from
            using it.
          </p>
        )}
        <br />
        <label htmlFor="proxyAuthToken">
          Proxy Auth Token (optional — only needed if your GTR Proxy is
          configured to require one):
        </label>
        <br />
        <input
          id="proxyAuthToken"
          type="password"
          name="proxyAuthToken"
          value={proxyAuthToken}
          onChange={(e) => setProxyAuthToken(e.target.value)}
          style={{ width: "90%", zoom: 1.2 }}
        />
      </form>
      <h2>Transloads</h2>
      <p>
        This is a list of downloads that have been intercepted by the extension.
        The extension will intercept downloads that are from Google Takeout and
        initiate a transload of them to Azure.
      </p>
      <p>
        Archives are sorted by the last 3 characters of the filename except the
        extension.
      </p>
      <button onClick={() => setDownloads({})}>Clear</button>
      <ul>
        {Object.entries(downloads)
          // Sort by the last 3 characters of the filename except the extension (which may not always be 3 characters), which is the archive number if possible.
          .sort((a, b) => {
            const aName = a[1].name;
            const bName = b[1].name;
            const aNameNoExt = aName.substring(0, aName.lastIndexOf("."));
            const bNameNoExt = bName.substring(0, bName.lastIndexOf("."));
            const aNameNoExtLast3 = aNameNoExt.substring(
              aNameNoExt.length - 3,
              aNameNoExt.length
            );
            const bNameNoExtLast3 = bNameNoExt.substring(
              bNameNoExt.length - 3,
              bNameNoExt.length
            );
            return bNameNoExtLast3.localeCompare(aNameNoExtLast3);
          })
          .map(([key, value]) => (
            <li key={value.name}>
              {[value.name, value.status, value.reason]
                .filter((x) => x !== undefined)
                .join(" - ")}
            </li>
          ))}
      </ul>
    </div>
  );
}
