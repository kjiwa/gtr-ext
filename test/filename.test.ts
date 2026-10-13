import { describe, expect, it } from "vitest";
import { resolveFilename, sanitizeFilename } from "../src/filename";

const NOW = Date.parse("2026-01-02T03:04:05.678Z");
const URL_WITH_NAME = "https://takeout.google.com/takeout/download/takeout-001.zip?j=1";

function resolve(overrides: Partial<Parameters<typeof resolveFilename>[0]>): string {
  return resolveFilename({ contentDisposition: null, itemFilename: undefined, url: "https://takeout.google.com/takeout/download", now: NOW, ...overrides });
}

describe("resolveFilename", () => {
  it("prefers Content-Disposition over the item filename and URL", () => {
    expect(resolve({ contentDisposition: 'attachment; filename="a.zip"', itemFilename: "/tmp/b.zip", url: URL_WITH_NAME })).toBe("a.zip");
  });

  it("decodes filename*=UTF-8'' and prefers it over filename", () => {
    expect(resolve({ contentDisposition: "attachment; filename=\"fallback.zip\"; filename*=UTF-8''caf%C3%A9%20one.zip" })).toBe("café one.zip");
  });

  it("reads quoted names with escaped quotes and unquoted tokens", () => {
    expect(resolve({ contentDisposition: 'attachment; filename="a\\"b.zip"' })).toBe('a"b.zip');
    expect(resolve({ contentDisposition: "attachment; filename=plain.zip" })).toBe("plain.zip");
  });

  it("ignores an extended name with an unknown charset or bad escapes", () => {
    expect(resolve({ contentDisposition: "attachment; filename*=latin1''x.zip; filename=\"ok.zip\"" })).toBe("ok.zip");
    expect(resolve({ contentDisposition: "attachment; filename*=UTF-8''%E0%A4%A; filename=\"ok.zip\"" })).toBe("ok.zip");
  });

  it.each([
    ["/home/u/Downloads/b.zip", "b.zip"],
    ["C:\\Users\\u\\Downloads\\c.zip", "c.zip"],
  ])("takes the basename of item filename %s", (itemFilename, expected) => {
    expect(resolve({ itemFilename })).toBe(expected);
  });

  it("falls back to the last URL path segment, decoded", () => {
    expect(resolve({ url: "https://takeout.google.com/takeout/download/my%20file.zip?j=1" })).toBe("my file.zip");
  });

  it("falls back to a dated name", () => {
    expect(resolve({ itemFilename: "", url: "https://takeout.google.com/" })).toBe("takeout-2026-01-02T03-04-05-678Z.bin");
  });

  it("skips a candidate that sanitizes to nothing", () => {
    expect(resolve({ contentDisposition: 'attachment; filename="..."', itemFilename: "real.zip" })).toBe("real.zip");
  });

  it("drops directories smuggled into Content-Disposition", () => {
    expect(resolve({ contentDisposition: 'attachment; filename="../../etc/passwd"' })).toBe("passwd");
  });
});

describe("sanitizeFilename", () => {
  it("removes control characters, separators and leading dots, and collapses whitespace", () => {
    expect(sanitizeFilename("..\u0000 a \t\n  b\\c/d.zip ")).toBe("a bcd.zip");
  });

  it("caps at 200 characters and keeps the extension", () => {
    const name = sanitizeFilename(`${"x".repeat(300)}.zip`);
    expect(name).toHaveLength(200);
    expect(name.endsWith(".zip")).toBe(true);
  });

  it("leaves short names alone", () => {
    expect(sanitizeFilename("takeout-001.zip")).toBe("takeout-001.zip");
  });
});
