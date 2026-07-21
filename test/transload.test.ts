import {
  transload,
  createJobPlan,
  sourceToGtrProxySource
} from "../src/transload";

const proxyBaseUrl = "https://gtr-proxy.example.test";

describe("createJobPlan", () => {
  const mockHeadResponse = (contentLength: number) => {
    return jest.spyOn(global, "fetch").mockResolvedValue({
      headers: {
        get: (name: string) =>
          name === "content-length" ? String(contentLength) : null
      }
    } as unknown as Response);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("is able to produce a job plan from a source", async () => {
    const mb = 100;
    const length = 209715200; // 200 MiB
    mockHeadResponse(length);

    const jobPlan = await createJobPlan("https://example.com/file.zip", mb);

    expect(jobPlan.chunks.length).toBeGreaterThan(0);
    expect(jobPlan.chunks[0].start).toBe(0);
    expect(jobPlan.chunks[0].size).toBe(mb * 1024 * 1024);
    // Check last chunk in jobPlan
    expect(jobPlan.chunks[jobPlan.chunks.length - 1].start).toBeGreaterThan(0);
    expect(jobPlan.chunks[jobPlan.chunks.length - 1].size).toBeGreaterThan(0);
    expect(
      jobPlan.chunks[jobPlan.chunks.length - 1].start +
        jobPlan.chunks[jobPlan.chunks.length - 1].size
    ).toBe(jobPlan.length);
    // Make sure none of the job plans have a size of 0
    jobPlan.chunks.forEach((chunk) => {
      expect(chunk.size).toBeGreaterThan(0);
    });
    expect(jobPlan.length).toBe(length);
  });

  test("throws if the source has no content-length header", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      headers: { get: () => null }
    } as unknown as Response);

    await expect(createJobPlan("https://example.com/file.zip")).rejects.toThrow(
      "No content-length header"
    );
  });

  test("defaults to a 3000 MB chunk size when unset", async () => {
    const length = 3000 * 1024 * 1024 + 1;
    mockHeadResponse(length);

    const jobPlan = await createJobPlan("https://example.com/file.zip");

    expect(jobPlan.chunks.length).toBe(2);
    expect(jobPlan.chunks[0].size).toBe(3000 * 1024 * 1024);
  });
});

describe("sourceToGtrProxySource", () => {
  test("should return a proxied URL", () => {
    const sourceUrl = "https://example.com/file.zip";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/file.zip`;
    expect(sourceToGtrProxySource(sourceUrl, proxyBaseUrl)).toBe(expectedUrl);
  });

  test("should handle encoded slashes in source URL", () => {
    const sourceUrl = "https://example.com/some%2Fpath/file.zip";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/some%252Fpath/file.zip`;
    expect(sourceToGtrProxySource(sourceUrl, proxyBaseUrl)).toBe(expectedUrl);
  });

  test("should include encodedCookies if provided", () => {
    const sourceUrl = "https://example.com/file.zip";
    const cookies = "testcookies";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/file.zip?a=${cookies}`;
    expect(sourceToGtrProxySource(sourceUrl, proxyBaseUrl, cookies)).toBe(
      expectedUrl
    );
  });

  test("should use & for cookies if query params already exist", () => {
    const sourceUrl = "https://example.com/file.zip?param=value";
    const cookies = "testcookies";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/file.zip?param=value&a=${cookies}`;
    expect(sourceToGtrProxySource(sourceUrl, proxyBaseUrl, cookies)).toBe(
      expectedUrl
    );
  });

  test("should include the proxy auth token if provided", () => {
    const sourceUrl = "https://example.com/file.zip";
    const token = "s3cr3t";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/file.zip?gtr_token=${token}`;
    expect(
      sourceToGtrProxySource(sourceUrl, proxyBaseUrl, undefined, token)
    ).toBe(expectedUrl);
  });

  test("should append the token after cookies when both are provided", () => {
    const sourceUrl = "https://example.com/file.zip";
    const cookies = "testcookies";
    const token = "s3cr3t";
    const expectedUrl = `${proxyBaseUrl}/p/example.com/file.zip?a=${cookies}&gtr_token=${token}`;
    expect(
      sourceToGtrProxySource(sourceUrl, proxyBaseUrl, cookies, token)
    ).toBe(expectedUrl);
  });

  test("should omit the token param when no token is provided", () => {
    const sourceUrl = "https://example.com/file.zip";
    const result = sourceToGtrProxySource(
      sourceUrl,
      proxyBaseUrl,
      undefined,
      ""
    );
    expect(result).not.toContain("gtr_token");
  });

  test("should throw an error if the generated URL is too long", () => {
    const sourceUrl = "https://example.com/file.zip";
    const longCookies = "a".repeat(2048);
    expect(() => {
      sourceToGtrProxySource(sourceUrl, proxyBaseUrl, longCookies);
    }).toThrow(/Proxy URL length \(\d+\) exceeds the maximum of 2048 bytes./);
  });
});

// These tests exercise the full transload path against a real gtr-proxy
// instance and a real Azure Storage account. They are opt-in (skipped by
// default) since they require live credentials and network access, and are
// unsuitable for CI to depend on.
const AZURE_STORAGE_CONNECTION_STRING =
  process.env.AZURE_STORAGE_CONNECTION_STRING;
const GTR_PROXY_BASE_URL = process.env.GTR_PROXY_BASE_URL;
const runIntegrationTests = Boolean(
  AZURE_STORAGE_CONNECTION_STRING && GTR_PROXY_BASE_URL
);

(runIntegrationTests ? describe : describe.skip)(
  "transload (integration)",
  () => {
    const someFileUrl = `${GTR_PROXY_BASE_URL}/200MB.zip`;

    test("can tell azure to transload a file", async () => {
      await transload(
        someFileUrl,
        AZURE_STORAGE_CONNECTION_STRING as string,
        "gtr-ext-test-medium-file.dat",
        GTR_PROXY_BASE_URL,
        50
      );
    }, 30000);

    test("can tell azure to transload a file that is from the proxy", async () => {
      const proxifiedSomeFileUrl = sourceToGtrProxySource(
        someFileUrl,
        GTR_PROXY_BASE_URL
      );

      await transload(
        proxifiedSomeFileUrl,
        AZURE_STORAGE_CONNECTION_STRING as string,
        "gtr-ext-test-medium-file-proxy.dat"
      );
    }, 30000);
  }
);
