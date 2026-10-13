import { uiExt } from "./browser";
import { generateSecret, loadConfig, saveConfig, validateConfig, type Config, type ConfigProblems } from "./config";
import { normalizeProxyBase } from "./protocol/urls";
import { byId, el } from "./ui/dom";
import { proxyOriginPattern, testConnection } from "./ui/connection";
import { sasExpiryNotice, type NoticeLevel } from "./ui/sas-notice";

const api = uiExt;
const LEVEL_LABELS: Record<NoticeLevel, string> = { ok: "OK.", warn: "Warning.", danger: "Problem." };

const form = byId<HTMLFormElement>("form");
const proxyInput = byId<HTMLInputElement>("proxy");
const secretInput = byId<HTMLInputElement>("secret");
const sasInput = byId<HTMLInputElement>("sas");
const grantButton = byId<HTMLButtonElement>("grant");
const permissionStatus = byId("permission-status");
const saveStatus = byId("save-status");

function formValues(): Config {
  return { enabled: false, proxyBase: proxyInput.value.trim(), secret: secretInput.value, sasUrl: sasInput.value.trim() };
}

function showNotice(element: HTMLElement, level: NoticeLevel | undefined, text: string): void {
  element.hidden = level === undefined;
  element.className = `notice ${level ?? ""}`.trim();
  element.replaceChildren(el("span", "label", `${level === undefined ? "" : LEVEL_LABELS[level]} `), text);
}

function showFieldProblem(input: HTMLInputElement, errorId: string, problem: string | undefined): void {
  byId(errorId).textContent = problem ?? "";
  input.setAttribute("aria-invalid", String(problem !== undefined));
}

function showProblems(problems: ConfigProblems, onlyFilled: boolean): void {
  const visible = (value: string, problem: string | undefined): string | undefined => (onlyFilled && value === "" ? undefined : problem);
  const values = formValues();
  showFieldProblem(proxyInput, "proxy-error", visible(values.proxyBase, problems.proxyBase));
  showFieldProblem(secretInput, "secret-error", visible(values.secret, problems.secret));
  showFieldProblem(sasInput, "sas-error", visible(values.sasUrl, problems.sasUrl));
}

function renderSasNotice(): void {
  const notice = sasExpiryNotice(sasInput.value, Date.now());
  if (notice === undefined || notice.level === "danger") {
    showNotice(byId("sas-notice"), undefined, "");
    return;
  }
  showNotice(byId("sas-notice"), notice.level, notice.text);
}

function validProxyBase(): string | undefined {
  try {
    return normalizeProxyBase(proxyInput.value);
  } catch {
    return undefined;
  }
}

async function renderPermission(): Promise<void> {
  const proxyBase = validProxyBase();
  if (proxyBase === undefined) {
    permissionStatus.textContent = "";
    grantButton.hidden = true;
    return;
  }
  const pattern = proxyOriginPattern(proxyBase);
  const granted = await api.permissions.contains({ origins: [pattern] });
  permissionStatus.textContent = granted ? "Access to the proxy is granted." : "Access to the proxy is not granted.";
  grantButton.hidden = granted;
}

function onInput(): void {
  showProblems(validateConfig(formValues(), Date.now()), true);
  renderSasNotice();
  saveStatus.textContent = "";
}

function onGrant(): void {
  const proxyBase = validProxyBase();
  if (proxyBase === undefined) {
    return;
  }
  void api.permissions.request({ origins: [proxyOriginPattern(proxyBase)] }).then(renderPermission);
}

async function onSave(event: Event): Promise<void> {
  event.preventDefault();
  const values = formValues();
  const problems = validateConfig(values, Date.now());
  showProblems(problems, false);
  if (Object.keys(problems).length > 0) {
    saveStatus.textContent = "Not saved. Fix the fields marked above.";
    return;
  }
  const request = api.permissions.request({ origins: [proxyOriginPattern(values.proxyBase)] }).catch(() => false);
  await saveConfig({ proxyBase: normalizeProxyBase(values.proxyBase), secret: values.secret, sasUrl: values.sasUrl }, api);
  saveStatus.textContent = (await request) ? "Saved." : "Saved, but access to the proxy was not granted.";
  await renderPermission();
}

function toggleSecret(): void {
  const button = byId("toggle-secret");
  const reveal = secretInput.type === "password";
  secretInput.type = reveal ? "text" : "password";
  button.textContent = reveal ? "Hide" : "Show";
  button.setAttribute("aria-pressed", String(reveal));
}

function generate(): void {
  secretInput.value = generateSecret();
  onInput();
  byId("copy-status").textContent = "Generated. Save to keep it, then set it on the Worker.";
}

async function copySecret(): Promise<void> {
  const status = byId("copy-status");
  if (secretInput.value === "") {
    status.textContent = "There is no secret to copy.";
    return;
  }
  try {
    await navigator.clipboard.writeText(secretInput.value);
    status.textContent = "Copied.";
  } catch {
    status.textContent = "Copy failed. Show the secret and copy it by hand.";
  }
}

async function runTest(): Promise<void> {
  const result = byId("test-result");
  const button = byId<HTMLButtonElement>("test");
  const values = formValues();
  const problems = validateConfig(values, Date.now());
  if (problems.proxyBase !== undefined || problems.secret !== undefined) {
    showProblems(problems, false);
    showNotice(result, "danger", problems.proxyBase ?? problems.secret ?? "");
    return;
  }
  button.disabled = true;
  result.hidden = false;
  result.className = "notice";
  result.textContent = "Testing...";
  const outcome = await testConnection(values.proxyBase, values.secret);
  showNotice(result, outcome.level, outcome.text);
  button.disabled = false;
}

async function main(): Promise<void> {
  const config = await loadConfig(api);
  proxyInput.value = config.proxyBase;
  secretInput.value = config.secret;
  sasInput.value = config.sasUrl;
  showProblems(validateConfig(formValues(), Date.now()), true);
  renderSasNotice();
  await renderPermission();
  form.addEventListener("submit", (event) => void onSave(event));
  for (const input of [proxyInput, secretInput, sasInput]) {
    input.addEventListener("input", onInput);
  }
  proxyInput.addEventListener("input", () => void renderPermission());
  grantButton.addEventListener("click", onGrant);
  byId("toggle-secret").addEventListener("click", toggleSecret);
  byId("generate").addEventListener("click", generate);
  byId("copy").addEventListener("click", () => void copySecret());
  byId("test").addEventListener("click", () => void runTest());
}

void main();
