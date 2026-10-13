export interface FilenameSources {
  contentDisposition: string | null;
  itemFilename: string | undefined;
  url: string;
  now: number;
}

const MAX_LENGTH = 200;
const EXTENSION = /\.[A-Za-z0-9]{1,16}$/;
const EXTENDED_PARAM = /filename\*\s*=\s*([^']*)'[^']*'([^;]*)/i;
const QUOTED_PARAM = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i;
const TOKEN_PARAM = /filename\s*=\s*([^;\s"]+)/i;

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function decodeExtended(charset: string, value: string): string | undefined {
  if (!/^utf-?8$/i.test(charset.trim())) {
    return undefined;
  }
  return decode(value.trim());
}

function dispositionFilename(header: string | null): string | undefined {
  if (header === null) {
    return undefined;
  }
  const extended = EXTENDED_PARAM.exec(header);
  const decoded = extended && decodeExtended(extended[1]!, extended[2]!);
  if (decoded) {
    return decoded;
  }
  const quoted = QUOTED_PARAM.exec(header);
  if (quoted) {
    return quoted[1]!.replace(/\\(.)/g, "$1");
  }
  return TOKEN_PARAM.exec(header)?.[1];
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

function urlFilename(url: string): string | undefined {
  try {
    return decode(basename(new URL(url).pathname));
  } catch {
    return undefined;
  }
}

function capLength(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MAX_LENGTH) {
    return name;
  }
  const extension = Array.from(EXTENSION.exec(name)?.[0] ?? "");
  return characters.slice(0, MAX_LENGTH - extension.length).join("") + extension.join("");
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/[/\\]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return capLength(cleaned);
}

export function resolveFilename({ contentDisposition, itemFilename, url, now }: FilenameSources): string {
  const candidates = [basename(dispositionFilename(contentDisposition) ?? ""), basename(itemFilename ?? ""), urlFilename(url)];
  for (const candidate of candidates) {
    const name = candidate ? sanitizeFilename(candidate) : "";
    if (name !== "") {
      return name;
    }
  }
  return `takeout-${new Date(now).toISOString().replace(/[:.]/g, "-")}.bin`;
}
