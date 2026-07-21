import { azBlobSASUrlToProxyPathname } from "../src/azb";

describe("azBlobSASUrlToProxyPathname", () => {
  const proxyBase = "https://gtr-proxy.example.test";

  test("rewrites an Azure blob SAS URL into a proxy path", () => {
    const azbUrl = new URL(
      "https://myaccount.blob.core.windows.net/mycontainer/path/to/blob.zip?sv=2021-08-06&sig=abc123"
    );

    const result = azBlobSASUrlToProxyPathname(azbUrl, proxyBase);

    expect(result.origin).toBe(proxyBase);
    expect(result.pathname).toBe(
      "/p-azb/myaccount/mycontainer/path/to/blob.zip"
    );
    expect(result.searchParams.get("sv")).toBe("2021-08-06");
    expect(result.searchParams.get("sig")).toBe("abc123");
  });

  test("throws if the account name is missing", () => {
    const azbUrl = new URL("https://./mycontainer/blob.zip");
    expect(() => azBlobSASUrlToProxyPathname(azbUrl, proxyBase)).toThrow(
      /account name/
    );
  });

  test("throws if the container name is missing", () => {
    const azbUrl = new URL("https://myaccount.blob.core.windows.net/");
    expect(() => azBlobSASUrlToProxyPathname(azbUrl, proxyBase)).toThrow(
      /container name/
    );
  });

  test("throws if the blob name is missing", () => {
    const azbUrl = new URL(
      "https://myaccount.blob.core.windows.net/mycontainer"
    );
    expect(() => azBlobSASUrlToProxyPathname(azbUrl, proxyBase)).toThrow(
      /blob name/
    );
  });
});
