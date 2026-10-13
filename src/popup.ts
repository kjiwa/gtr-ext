import { uiExt } from "./browser";
import { isReady, loadConfig, saveConfig, validateConfig, type Config } from "./config";
import { TRANSFERS_KEY, type Transfer } from "./transfers";
import { byId, el } from "./ui/dom";
import { firstProblem } from "./ui/setup";
import { hasFinished, sortTransfers, toTransferView, type TransferView } from "./ui/transfers-view";

const api = uiExt;
const switchButton = byId<HTMLButtonElement>("enabled");
const switchState = byId("switch-state");
const banner = byId("setup-banner");
const problemText = byId("setup-problem");
const list = byId("transfers");
const empty = byId("empty");
const clearButton = byId<HTMLButtonElement>("clear-finished");
const status = byId("status");

let lastPhases = new Map<string, string>();
let announced = false;

function renderSwitch(config: Config, ready: boolean): void {
  switchButton.setAttribute("aria-checked", String(config.enabled));
  switchButton.disabled = !ready;
  switchState.textContent = config.enabled ? "On" : "Off";
}

function renderBanner(config: Config): void {
  const problem = firstProblem(validateConfig(config, Date.now()));
  banner.hidden = problem === undefined;
  problemText.textContent = problem ?? "";
}

function renderTransfer(view: TransferView): HTMLElement {
  const head = el("div", "transfer-head", el("span", "transfer-name", view.name), el("span", "phase", view.phaseLabel));
  const item = el("li", `transfer ${view.phase}`, head);
  if (view.fraction !== undefined && view.percent !== undefined) {
    const fill = el("span", "progress-fill");
    fill.style.width = `${view.percent}%`;
    const bar = el("div", "progress", fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Progress of ${view.name}`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(view.percent));
    item.append(bar);
  }
  const meta = [view.sizeText, view.speedText].filter((part): part is string => part !== undefined);
  if (meta.length > 0) {
    item.append(el("div", "transfer-meta", ...meta.map((part) => el("span", undefined, part))));
  }
  if (view.errorText !== undefined) {
    item.append(el("p", "error-text", `${view.errorText} ${view.nextStep ?? ""}`.trim()));
  }
  if (view.cancellable) {
    const cancel = el("button", "button", "Cancel");
    cancel.type = "button";
    cancel.dataset["cancel"] = view.id;
    cancel.setAttribute("aria-label", `Cancel ${view.name}`);
    item.append(cancel);
  }
  return item;
}

function announceChanges(transfers: readonly Transfer[]): void {
  const phases = new Map(transfers.map((transfer) => [transfer.id, transfer.phase]));
  const changed = transfers.find((transfer) => lastPhases.get(transfer.id) !== transfer.phase);
  if (announced && changed) {
    status.textContent = `${changed.name}: ${toTransferView(changed, Date.now()).phaseLabel}`;
  }
  lastPhases = phases;
  announced = true;
}

function renderTransfers(transfers: readonly Transfer[]): void {
  const focused = (document.activeElement as HTMLElement | null)?.dataset["cancel"];
  const now = Date.now();
  list.replaceChildren(...sortTransfers(transfers).map((transfer) => renderTransfer(toTransferView(transfer, now))));
  empty.hidden = transfers.length > 0;
  clearButton.disabled = !hasFinished(transfers);
  if (focused !== undefined) {
    list.querySelector<HTMLElement>(`[data-cancel="${CSS.escape(focused)}"]`)?.focus();
  }
  announceChanges(transfers);
}

async function readTransfers(): Promise<Transfer[]> {
  const stored = await api.storage.local.get(TRANSFERS_KEY);
  return Object.values((stored[TRANSFERS_KEY] as Record<string, Transfer> | undefined) ?? {});
}

async function refresh(): Promise<void> {
  const [config, transfers] = await Promise.all([loadConfig(api), readTransfers()]);
  renderSwitch(config, isReady(config));
  renderBanner(config);
  renderTransfers(transfers);
}

function openSettings(): void {
  void api.runtime.openOptionsPage();
}

function onListClick(event: Event): void {
  const id = (event.target as HTMLElement).dataset["cancel"];
  if (id !== undefined) {
    void api.runtime.sendMessage({ type: "cancel", id });
  }
}

async function onSwitchClick(): Promise<void> {
  await saveConfig({ enabled: switchButton.getAttribute("aria-checked") !== "true" }, api);
}

function main(): void {
  switchButton.addEventListener("click", () => void onSwitchClick());
  list.addEventListener("click", onListClick);
  clearButton.addEventListener("click", () => void api.runtime.sendMessage({ type: "clearFinished" }));
  byId("open-settings").addEventListener("click", openSettings);
  byId("settings").addEventListener("click", openSettings);
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") {
      void refresh();
    }
  });
  void refresh();
}

main();
