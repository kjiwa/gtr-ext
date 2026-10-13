import { ext, type ExtApi } from "./browser";
import { normalizeProxyBase } from "./protocol/urls";
import { toBase64Url } from "./protocol/ticket";
import { parseContainerSas, SasError } from "./sas";

export interface Config {
  enabled: boolean;
  proxyBase: string;
  secret: string;
  sasUrl: string;
}

export type ConfigProblems = Partial<Record<"proxyBase" | "secret" | "sasUrl", string>>;

const SECRET_BYTES = 32;
const KEYS = ["enabled", "proxyBase", "secret", "sasUrl"];

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function loadConfig(api: ExtApi = ext): Promise<Config> {
  const stored = await api.storage.local.get(KEYS);
  return { enabled: stored["enabled"] === true, proxyBase: text(stored["proxyBase"]), secret: text(stored["secret"]), sasUrl: text(stored["sasUrl"]) };
}

export async function saveConfig(partial: Partial<Config>, api: ExtApi = ext): Promise<void> {
  await api.storage.local.set({ ...partial });
}

function sentence(message: string): string {
  const capitalized = message.charAt(0).toUpperCase() + message.slice(1);
  return capitalized.endsWith(".") ? capitalized : `${capitalized}.`;
}

function proxyBaseProblem(proxyBase: string): string | undefined {
  if (proxyBase.trim() === "") {
    return "Enter the URL of your proxy.";
  }
  try {
    normalizeProxyBase(proxyBase);
  } catch (error) {
    return sentence((error as Error).message);
  }
  return undefined;
}

function sasProblem(sasUrl: string, now: number): string | undefined {
  if (sasUrl.trim() === "") {
    return "Enter the container SAS URL.";
  }
  try {
    parseContainerSas(sasUrl, now);
  } catch (error) {
    if (error instanceof SasError) {
      return error.message;
    }
    throw error;
  }
  return undefined;
}

export function validateConfig(config: Config, now: number): ConfigProblems {
  const problems: ConfigProblems = {};
  const proxyBase = proxyBaseProblem(config.proxyBase);
  const secret = config.secret === "" ? "Enter the shared secret, or generate one." : undefined;
  const sasUrl = sasProblem(config.sasUrl, now);
  if (proxyBase) {
    problems.proxyBase = proxyBase;
  }
  if (secret) {
    problems.secret = secret;
  }
  if (sasUrl) {
    problems.sasUrl = sasUrl;
  }
  return problems;
}

export function isReady(config: Config, now: number = Date.now()): boolean {
  return Object.keys(validateConfig(config, now)).length === 0;
}

export function generateSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}
