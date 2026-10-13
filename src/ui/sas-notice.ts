import { parseContainerSas, SasError } from "../sas";
import { formatDateTime } from "./format";

export type NoticeLevel = "ok" | "warn" | "danger";

export interface SasNotice {
  level: NoticeLevel;
  text: string;
}

const WARN_WITHIN_MS = 24 * 60 * 60 * 1000;

export function sasExpiryNotice(sasUrl: string, now: number): SasNotice | undefined {
  if (sasUrl.trim() === "") {
    return undefined;
  }
  try {
    const { expiresAt } = parseContainerSas(sasUrl.trim(), now);
    if (expiresAt === undefined) {
      return { level: "ok", text: "This SAS URL has no expiry." };
    }
    const when = formatDateTime(expiresAt);
    if (expiresAt - now <= WARN_WITHIN_MS) {
      return { level: "warn", text: `Expires soon: ${when}. Generate a new SAS URL before then.` };
    }
    return { level: "ok", text: `Valid until ${when}.` };
  } catch (error) {
    if (error instanceof SasError) {
      return { level: "danger", text: error.message };
    }
    throw error;
  }
}
