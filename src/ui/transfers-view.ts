import { isTerminal, type Transfer, type TransferPhase } from "../transfers";
import { formatBytes, formatSpeed } from "./format";

export interface TransferView {
  id: string;
  name: string;
  phase: TransferPhase;
  phaseLabel: string;
  fraction: number | undefined;
  percent: number | undefined;
  sizeText: string | undefined;
  speedText: string | undefined;
  errorText: string | undefined;
  cancellable: boolean;
}

const PHASE_LABELS: Record<TransferPhase, string> = {
  starting: "Starting",
  copying: "Copying to Azure",
  committing: "Finalizing",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export function phaseLabel(phase: TransferPhase): string {
  return PHASE_LABELS[phase];
}

export function progressFraction(transfer: Pick<Transfer, "phase" | "bytesDone" | "bytesTotal">): number | undefined {
  if (transfer.phase === "done") {
    return 1;
  }
  if (transfer.bytesTotal <= 0) {
    return undefined;
  }
  return Math.min(Math.max(transfer.bytesDone / transfer.bytesTotal, 0), 1);
}

export function sortTransfers(transfers: readonly Transfer[]): Transfer[] {
  return [...transfers].sort((a, b) => b.startedAt - a.startedAt);
}

export function hasFinished(transfers: readonly Transfer[]): boolean {
  return transfers.some((transfer) => isTerminal(transfer.phase));
}

function sizeText(transfer: Transfer): string | undefined {
  if (transfer.bytesTotal <= 0) {
    return undefined;
  }
  if (transfer.phase === "done") {
    return formatBytes(transfer.bytesTotal);
  }
  return `${formatBytes(transfer.bytesDone)} of ${formatBytes(transfer.bytesTotal)}`;
}

function speedText(transfer: Transfer, now: number): string | undefined {
  const seconds = (now - transfer.startedAt) / 1000;
  if (transfer.phase !== "copying" || seconds <= 0 || transfer.bytesDone <= 0) {
    return undefined;
  }
  return formatSpeed(transfer.bytesDone / seconds);
}

function isFailure(phase: TransferPhase): boolean {
  return phase === "failed" || phase === "interrupted";
}

export function toTransferView(transfer: Transfer, now: number): TransferView {
  const fraction = progressFraction(transfer);
  const failure = isFailure(transfer.phase);
  return {
    id: transfer.id,
    name: transfer.name,
    phase: transfer.phase,
    phaseLabel: phaseLabel(transfer.phase),
    fraction,
    percent: fraction === undefined ? undefined : Math.round(fraction * 100),
    sizeText: sizeText(transfer),
    speedText: speedText(transfer, now),
    errorText: failure ? (transfer.error?.message ?? "The transfer did not finish. Start the download again in Google Takeout.") : undefined,
    cancellable: !isTerminal(transfer.phase),
  };
}
