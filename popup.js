const scanButton = document.querySelector("#scan-qr");
const showAddButton = document.querySelector("#show-add");
const showImportButton = document.querySelector("#show-import");
const exportAccountsButton = document.querySelector("#export-accounts");
const toggleManageButton = document.querySelector("#toggle-manage");
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
const accountQr = document.querySelector("#account-qr");
const qrClose = document.querySelector("#qr-close");
const qrAccount = document.querySelector("#qr-account");
const qrImage = document.querySelector("#qr-image");
const STORAGE_KEY = "mfaAccounts";
const PERIOD = 30;
const { base32ToBytes, generateTotp } = AuthenticatorTOTP;
let pendingDeleteId = null;
let renderVersion = 0;

/**
 * 记录验证器的使用次数。
 *
 * @param {string} accountId 已使用的验证器 ID。
 * @returns {Promise<void>} 完成 Promise。
 */
async function recordAccountUse(accountId) {
  const { [STORAGE_KEY]: savedAccounts = [] } = await chrome.storage.local.get(STORAGE_KEY);
  const accounts = savedAccounts.map((account) => account.id === accountId
    ? { ...account, usageCount: (Number(account.usageCount) || 0) + 1 }
    : account);
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

/**
 * 判断存储变化是否只涉及账户使用次数。
 *
 * @param {{oldValue?: object[], newValue?: object[]}} change 存储变化详情。
 * @returns {boolean} 是否可直接复用现有卡片。
 */
function isUsageCountChange(change) {
  const previous = change.oldValue || [];
  const next = change.newValue || [];
  if (previous.length !== next.length) return false;
  const previousById = new Map(previous.map((account) => [account.id, account]));
  return next.every((account) => {
    const previousAccount = previousById.get(account.id);
    if (!previousAccount) return false;
    const { usageCount: previousUsageCount, ...previousDetails } = previousAccount;
    const { usageCount, ...details } = account;
    return JSON.stringify(previousDetails) === JSON.stringify(details);
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
 * 生成可被通用身份验证器扫描的 TOTP 配置链接。
 *
 * @param {{issuer?: string, account?: string, name?: string, secret: string}} account 账户记录。
 * @returns {string} otpauth 配置链接。
 */
function toOtpauthUri(account) {
  const { issuer, account: accountName } = getAccountLabels(account);
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
    : encodeURIComponent(accountName);
  const issuerParam = issuer ? `&issuer=${encodeURIComponent(issuer)}` : "";
  return `otpauth://totp/${label}?secret=${encodeURIComponent(account.secret)}${issuerParam}`;
}

/**
 * 展示账户配置二维码；编码完全在扩展本地完成。
 *
 * @param {{issuer?: string, account?: string, name?: string, secret: string}} account 账户记录。
 * @returns {void}
 */
function showAccountQr(account) {
  const { issuer, account: accountName } = getAccountLabels(account);
  const code = qrcode(0, "M");
  code.addData(toOtpauthUri(account), "Byte");
  code.make();
  qrAccount.textContent = issuer && accountName ? `${issuer}（${accountName}）` : issuer || accountName;
  qrImage.src = code.createDataURL(4, 4);
  accountQr.hidden = false;
  qrClose.focus();
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
  accounts.sort((left, right) => (Number(right.usageCount) || 0) - (Number(left.usageCount) || 0));
  accountsList.replaceChildren();
  emptyState.hidden = accounts.length > 0;
  accountCount.textContent = `${accounts.length} 个验证器`;

  for (const account of accounts) {
    const labels = getAccountLabels(account);
    const item = document.createElement("li");
    item.className = "account-item";
    item.dataset.accountId = account.id;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.setAttribute("aria-label", `复制 ${labels.issuer} 的当前验证码`);
    item.innerHTML = `
      <div class="account-details">
        <div class="account-name"></div>
        <div class="code-row"><span class="token-code">------</span><span class="copy-hint" hidden>已复制</span></div>
        <div class="account-sub" hidden></div>
      </div>
      <div class="account-controls">
        <button class="account-qr" type="button" aria-label="显示 ${labels.issuer} 的二维码" title="显示二维码">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 3h7v7H3V3zm2 2v3h3V5H5zm9-2h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5zm8-2h2v2h-2v-2zm3 0h2v2h-2v-2zm-3 3h2v2h-2v-2zm3 0h2v2h-2v-2zm3-3h2v7h-2v-7zm-3 6h2v1h-2v-1z"/></svg>
        </button>
        <span class="countdown" data-seconds="30"></span>
      </div>
      <button class="account-delete" type="button" aria-label="删除 ${labels.issuer}">×</button>
    `;
    item.querySelector(".account-name").textContent = labels.issuer || labels.account;
    const accountSub = item.querySelector(".account-sub");
    const subtitle = labels.issuer && labels.account ? labels.account : "";
    accountSub.textContent = subtitle;
    accountSub.hidden = !subtitle;
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
      await recordAccountUse(account.id);
      const copyHint = item.querySelector(".copy-hint");
      copyHint.hidden = false;
      window.setTimeout(() => { copyHint.hidden = true; }, 500);
    };
    item.addEventListener("click", () => {
      if (accountsList.classList.contains("is-manage-mode")) return;
      copyCode().catch(() => {});
    });
    item.addEventListener("keydown", (event) => {
      if (event.target.closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (accountsList.classList.contains("is-manage-mode")) return;
        copyCode().catch(() => {});
      }
    });
    item.querySelector(".account-delete").addEventListener("click", async (event) => {
      event.stopPropagation();
      pendingDeleteId = account.id;
      confirmAccount.textContent = `${labels.issuer}（${labels.account}）`;
      deleteConfirm.hidden = false;
    });
    item.querySelector(".account-qr").addEventListener("click", (event) => {
      event.stopPropagation();
      showAccountQr(account);
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
  if (areaName !== "local" || !changes[STORAGE_KEY]) return;
  if (isUsageCountChange(changes[STORAGE_KEY])) return;
  renderAccounts();
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
  const lines = accounts.map(toOtpauthUri);
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "authenticator-backup.txt";
  link.click();
  URL.revokeObjectURL(url);
});

toggleManageButton?.addEventListener("click", () => {
  const manageMode = accountsList.classList.toggle("is-manage-mode");
  toggleManageButton.classList.toggle("is-active", manageMode);
  toggleManageButton.setAttribute("aria-pressed", String(manageMode));
  toggleManageButton.title = manageMode ? "完成管理" : "管理";
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

qrClose?.addEventListener("click", () => { accountQr.hidden = true; });
accountQr?.addEventListener("click", (event) => {
  if (event.target === accountQr) accountQr.hidden = true;
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
