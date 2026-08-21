const scanButton = document.querySelector("#scan-qr");
const showAddButton = document.querySelector("#show-add");
const showImportButton = document.querySelector("#show-import");
const exportAccountsButton = document.querySelector("#export-accounts");
const toggleReorderButton = document.querySelector("#toggle-reorder");
const reorderHint = document.querySelector("#reorder-hint");
const accountCount = document.querySelector("#account-count");
const accountsList = document.querySelector("#accounts");
const emptyState = document.querySelector("#empty-state");
const importPanel = document.querySelector("#import-panel");
const importClose = document.querySelector("#import-close");
const importInput = document.querySelector("#import-input");
const importSubmit = document.querySelector("#import-submit");
const importMessage = document.querySelector("#import-message");
const addPanel = document.querySelector("#add-panel");
const addClose = document.querySelector("#add-close");
const addIssuer = document.querySelector("#add-issuer");
const addAccount = document.querySelector("#add-account");
const addSecret = document.querySelector("#add-secret");
const addSubmit = document.querySelector("#add-submit");
const addMessage = document.querySelector("#add-message");
const deleteConfirm = document.querySelector("#delete-confirm");
const confirmAccount = document.querySelector("#confirm-account");
const confirmCancel = document.querySelector("#confirm-cancel");
const confirmDelete = document.querySelector("#confirm-delete");
const STORAGE_KEY = "mfaAccounts";
const PERIOD = 30;
const { base32ToBytes, generateTotp } = AuthenticatorTOTP;
let pendingDeleteId = null;
let reorderMode = false;
let reorderPointerItem = null;
let reorderPointerMoved = false;
let renderVersion = 0;

/**
 * 编辑模式拖动结束后，保存当前 DOM 中的账户顺序。
 *
 * @returns {Promise<void>} 完成 Promise。
 */
async function saveCurrentOrder() {
  const order = [...accountsList.children].map((element) => element.dataset.accountId);
  const { [STORAGE_KEY]: savedAccounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const position = new Map(order.map((id, index) => [id, index]));
  await chrome.storage.local.set({
    [STORAGE_KEY]: [...savedAccounts].sort((left, right) => position.get(left.id) - position.get(right.id)),
  });
}

/**
 * 获取显示字段，同时兼容仅有旧版 `name` 字段的账户记录。
 *
 * @param {{issuer?: string, account?: string, name?: string}} account 已保存的账户。
 * @returns {{issuer: string, account: string}} 显示字段。
 */
function getAccountLabels(account) {
  if (account.issuer || account.account) {
    return { issuer: account.issuer || "", account: account.account || "" };
  }
  const [issuer, ...accountParts] = String(account.name || "").split(":");
  return accountParts.length
    ? { issuer: issuer.trim(), account: accountParts.join(":").trim() }
    : { issuer: "", account: issuer.trim() };
}

/**
 * 渲染已保存账户，避免存储变更触发的并发渲染相互交错。
 *
 * @returns {Promise<void>} 完成 Promise。
 */
async function renderAccounts() {
  const currentVersion = ++renderVersion;
  const { [STORAGE_KEY]: accounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  if (currentVersion !== renderVersion) return;
  accountsList.replaceChildren();
  emptyState.hidden = accounts.length > 0;
  accountCount.textContent = `${accounts.length} 个验证器`;

  for (const account of accounts) {
    const labels = getAccountLabels(account);
    const item = document.createElement("li");
    item.className = "account-item";
    item.dataset.accountId = account.id;
    item.draggable = false;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `复制 ${labels.issuer} 的当前验证码`);
    item.innerHTML = `
      <div class="account-details">
        <div class="account-meta"></div>
        <div class="code-row"><span class="token-code">------</span><span class="copy-hint" hidden>已复制</span></div>
      </div>
      <span class="countdown" data-seconds="30"></span>
      <button class="account-delete" type="button" aria-label="删除 ${labels.issuer}">×</button>
    `;
    item.querySelector(".account-meta").textContent = labels.issuer && labels.account
      ? `${labels.issuer}（${labels.account}）`
      : labels.issuer || labels.account;
    try {
      item.querySelector(".token-code").textContent = await generateTotp(account.secret);
    } catch {
      item.querySelector(".token-code").textContent = "错误";
    }
    if (currentVersion !== renderVersion) return;
    const copyCode = async () => {
      const code = item.querySelector(".token-code").textContent;
      if (!/^\d{6}$/.test(code)) return;
      await navigator.clipboard.writeText(code);
      await chrome.runtime.sendMessage({ type: "FILL_TOTP", code }).catch(() => null);
      const copyHint = item.querySelector(".copy-hint");
      copyHint.hidden = false;
      window.setTimeout(() => { copyHint.hidden = true; }, 500);
    };
    item.addEventListener("click", () => {
      if (reorderMode) return;
      copyCode().catch(() => {});
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (reorderMode) return;
        copyCode().catch(() => {});
      }
    });
    item.querySelector(".account-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      pendingDeleteId = account.id;
      confirmAccount.textContent = `${labels.issuer}（${labels.account}）`;
      deleteConfirm.hidden = false;
    });
    item.addEventListener("pointerdown", (event) => {
      if (!reorderMode || event.button !== 0 || event.target.closest("button")) return;
      event.preventDefault();
      reorderPointerItem = item;
      reorderPointerMoved = false;
      item.setPointerCapture(event.pointerId);
      item.classList.add("is-dragging");
    });
    item.addEventListener("pointermove", (event) => {
      if (!reorderPointerItem) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".account-item");
      if (!target || target === reorderPointerItem || !accountsList.contains(target)) return;
      reorderPointerMoved = true;
      const box = target.getBoundingClientRect();
      accountsList.insertBefore(reorderPointerItem, event.clientY > box.top + box.height / 2 ? target.nextSibling : target);
    });
    item.addEventListener("pointerup", async () => {
      if (!reorderPointerItem) return;
      const movedItem = reorderPointerItem;
      reorderPointerItem = null;
      movedItem.classList.remove("is-dragging");
      if (reorderPointerMoved) await saveCurrentOrder();
    });
    accountsList.append(item);
  }

  if (currentVersion === renderVersion) updateCountdowns();
}

/**
 * 在新的 TOTP 周期开始时刷新所有验证码。
 *
 * @returns {Promise<void>} 完成 Promise。
 */
async function updateCodes() {
  const { [STORAGE_KEY]: accounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const codeElements = accountsList.querySelectorAll(".token-code");
  await Promise.all(accounts.map(async (account, index) => {
    try {
      codeElements[index].textContent = await generateTotp(account.secret);
    } catch {
      codeElements[index].textContent = "错误";
    }
  }));
}

/**
 * 更新圆环倒计时进度与紧急程度颜色。
 *
 * @returns {void}
 */
function updateCountdowns() {
  const seconds = PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
  const progress = ((PERIOD - seconds) / PERIOD) * 360;
  const ringColor = seconds > 15 ? "#2b9b72" : seconds > 7 ? "#d9912b" : "#d14b5a";
  for (const countdown of accountsList.querySelectorAll(".countdown")) {
    countdown.dataset.seconds = String(seconds);
    countdown.style.setProperty("--progress", `${progress}deg`);
    countdown.style.setProperty("--ring-color", ringColor);
  }
  if (seconds === PERIOD) updateCodes();
}

renderAccounts();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) renderAccounts();
});

setInterval(updateCountdowns, 1000);

/**
 * 显示指定输入卡片，同时收起另一张输入卡片。
 *
 * @param {HTMLElement} panel 需要展示的卡片。
 * @param {HTMLElement} input 首个获得焦点的输入框。
 * @param {HTMLElement} message 用于显示表单状态的元素。
 * @returns {void}
 */
function openFormPanel(panel, input, message) {
  importPanel.hidden = panel !== importPanel;
  addPanel.hidden = panel !== addPanel;
  message.textContent = "";
  message.classList.remove("is-error");
  input.focus();
}

showImportButton?.addEventListener("click", () => openFormPanel(importPanel, importInput, importMessage));
showAddButton?.addEventListener("click", () => openFormPanel(addPanel, addIssuer, addMessage));
importClose?.addEventListener("click", () => { importPanel.hidden = true; });
addClose?.addEventListener("click", () => { addPanel.hidden = true; });

addSubmit?.addEventListener("click", async () => {
  const issuer = addIssuer.value.trim();
  const account = addAccount.value.trim();
  const secret = addSecret.value.trim();
  addMessage.classList.remove("is-error");
  try {
    if (!secret) throw new Error("请填写密钥");
    const response = await chrome.runtime.sendMessage({
      type: "ADD_MANUAL_ACCOUNT",
      account: { issuer, account, secret },
    });
    if (!response?.ok) throw new Error(response?.error || "添加失败");
    addIssuer.value = "";
    addAccount.value = "";
    addSecret.value = "";
    addPanel.hidden = true;
  } catch (error) {
    addMessage.classList.add("is-error");
    addMessage.textContent = error.message || "添加失败";
  }
});

exportAccountsButton?.addEventListener("click", async () => {
  const { [STORAGE_KEY]: accounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  if (!accounts.length) return;
  const lines = accounts.map((account) => {
    const { issuer, account: accountName } = getAccountLabels(account);
    const hasIssuer = Boolean(issuer);
    const label = hasIssuer
      ? `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
      : encodeURIComponent(accountName);
    const issuerParam = hasIssuer ? `&issuer=${encodeURIComponent(issuer)}` : "";
    return `otpauth://totp/${label}?secret=${encodeURIComponent(account.secret)}${issuerParam}`;
  });
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "authenticator-backup.txt";
  link.click();
  URL.revokeObjectURL(url);
});

toggleReorderButton?.addEventListener("click", async () => {
  reorderMode = !reorderMode;
  toggleReorderButton.classList.toggle("is-active", reorderMode);
  toggleReorderButton.setAttribute("aria-pressed", String(reorderMode));
  toggleReorderButton.title = reorderMode ? "完成编辑" : "编辑";
  reorderHint.hidden = !reorderMode;
  accountsList.classList.toggle("is-reorder-mode", reorderMode);
  await renderAccounts();
});

importSubmit?.addEventListener("click", async () => {
  const lines = importInput.value.split(/\r?\n/);
  importSubmit.disabled = true;
  importMessage.classList.remove("is-error");
  importMessage.textContent = "导入中";
  try {
    const response = await chrome.runtime.sendMessage({ type: "IMPORT_ACCOUNTS", lines });
    if (!response?.ok) throw new Error(response?.error || "导入失败");
    importInput.value = "";
    importPanel.hidden = true;
  } catch (error) {
    importMessage.classList.add("is-error");
    importMessage.textContent = error.message || "导入失败";
  } finally {
    importSubmit.disabled = false;
  }
});

confirmCancel?.addEventListener("click", () => {
  pendingDeleteId = null;
  deleteConfirm.hidden = true;
});

confirmDelete?.addEventListener("click", async () => {
  if (!pendingDeleteId) return;
  const { [STORAGE_KEY]: savedAccounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  await chrome.storage.local.set({ [STORAGE_KEY]: savedAccounts.filter((saved) => saved.id !== pendingDeleteId) });
  pendingDeleteId = null;
  deleteConfirm.hidden = true;
});


scanButton?.addEventListener("click", async () => {
  scanButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有可用的浏览器标签页。");

    const url = tab.url || "";
    if (
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") ||
      url.startsWith("about:") ||
      url.startsWith("devtools://")
    ) {
      throw new Error("当前页面无法截图扫码，请打开普通网页后再试。");
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const response = await chrome.runtime.sendMessage({
      type: "START_SCAN",
      tabId: tab.id,
      dataUrl,
    });

    if (!response?.ok) throw new Error(response?.error || "无法开始扫码。");
    window.close();
  } catch (error) {
    alert(error.message || "无法开始扫码。");
    scanButton.disabled = false;
  }
});
