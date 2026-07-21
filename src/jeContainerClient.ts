// Just Enough ContainerClient
// A reimplementation of the Azure Storage ContainerClient that only supports
// the methods we need.
//
// Also modified to allow replacing the URL with a gtr-proxy base URL as an
// option.

import "isomorphic-fetch";
import fetchBuilder from "fetch-retry";
import { azBlobSASUrlToProxyPathname } from "./azb";
import { PROXY_TOKEN_PARAM } from "./constants";

const fetch = fetchBuilder(globalThis.fetch);

// Azure Storage REST API version used for both the stage and commit calls.
const AZURE_STORAGE_API_VERSION = "2021-08-06";

// Shared retry behavior for requests that may transiently fail, whether
// served directly by Azure or relayed through a gtr-proxy instance.
const RETRY_OPTS = {
  retries: 10,
  retryDelay: 1000,
  retryOn: [409, 520, 524, 500, 503, 530]
};

export class ContainerClient {
  constructor(public readonly containerUrl: string) {}

  getBlockBlobClient(
    blobName: string,
    gtrProxyBase?: string,
    proxyAuthToken?: string
  ): BlockBlobClient {
    return new BlockBlobClient(this, blobName, gtrProxyBase, proxyAuthToken);
  }
}

export class BlockBlobClient {
  constructor(
    public readonly containerClient: ContainerClient,
    public readonly blobName: string,
    public readonly gtrProxyBase?: string,
    public readonly proxyAuthToken?: string
  ) {}

  // Builds the direct (non-proxied) Azure blob URL for this blob, with the
  // given extra query string appended to the container's SAS query.
  private buildBlobUrl(extraQuery: string): URL {
    const containerUrl = new URL(this.containerClient.containerUrl);
    return new URL(
      containerUrl.protocol +
        "//" +
        containerUrl.host +
        containerUrl.pathname +
        `/${this.blobName}` +
        containerUrl.search +
        extraQuery
    );
  }

  async stageBlockFromURL(
    blockId: string,
    sourceUrl: string,
    offset: number,
    count: number
  ): Promise<Response> {
    // Note: sourceUrl may carry credentials (cookies and/or a proxy auth
    // token), so it must never be logged.
    console.log(`Staging block ${blockId} (blob ${this.blobName})`);
    const blobUrl = this.buildBlobUrl(`&blockid=${blockId}&comp=block`);

    let fetchBlobUrl;
    if (this.gtrProxyBase) {
      fetchBlobUrl = azBlobSASUrlToProxyPathname(blobUrl, this.gtrProxyBase);
      if (this.proxyAuthToken) {
        fetchBlobUrl.searchParams.set(PROXY_TOKEN_PARAM, this.proxyAuthToken);
      }
    } else {
      fetchBlobUrl = blobUrl;
    }

    const resp = await fetch(fetchBlobUrl.toString(), {
      method: "PUT",
      ...RETRY_OPTS,
      headers: {
        "x-ms-version": AZURE_STORAGE_API_VERSION,
        "x-ms-copy-source": sourceUrl,
        "x-ms-source-range": `bytes=${offset}-${offset + count - 1}`
      },
      body: ""
    });
    if (resp.ok) {
      return resp;
    }
    const text = await resp.text();
    throw new Error(`Failed to stage block: ${resp.status} ${text}`);
  }

  async commitBlockList(blocks: string[]): Promise<Response> {
    console.log(`Committing block list of ${blocks.length} block(s)`);
    const blobUrl = this.buildBlobUrl(`&comp=blocklist`);
    const data = `<?xml version="1.0" encoding="utf-8"?>
<BlockList>
${blocks.map((blockId) => `<Latest>${blockId}</Latest>`).join("\n")}
</BlockList>`;

    const resp = await fetch(blobUrl.toString(), {
      method: "PUT",
      body: data,
      ...RETRY_OPTS,
      headers: {
        "x-ms-version": AZURE_STORAGE_API_VERSION
      }
    });

    if (resp.ok) {
      return resp;
    }
    throw new Error(`Failed to commit block list: ${resp.status}`);
  }
}
