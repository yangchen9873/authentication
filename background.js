importScripts("lib/totp.js");

const STORAGE_KEY = "mfaAccounts";
const PERIOD = 30;
const { base32ToBytes, normalizeSecret } = AuthenticatorTOTP;

/**
 * 从扩展本地存储读取数据。
 *
 * @param {string} key 存储键。
 * @returns {Promise<Record<string, unknown>>} 存储值映射。
 */
function storageGet(key) {
  return chrome.storage.local.get(key);
}

/**
 * 将数据写入扩展本地存储。
 *
 * @param {Record<string, unknown>} value 待写入的数据。
 * @returns {Promise<void>} 完成 Promise。
 */
function storageSet(value) {
  return chrome.storage.local.set(value);
}

/**
 * 解析受支持的 TOTP 配置 URI。
 *
 * @param {unknown} value 二维码内容或 URI 文本。
 * @returns {{name: string, issuer: string, account: string, secret: string}} 规范化后的账户数据。
 * @throws {Error} URI 或 TOTP 配置不受支持时抛出异常。
 */
function parseOtpauth(value) {
  let normalizedValue = String(value || "").trim().replace(/^\uFEFF/, "");
  if (!/^otpauth:/i.test(normalizedValue)) {
    try {
      const decodedValue = decodeURIComponent(normalizedValue);
      if (/^otpauth:/i.test(decodedValue)) normalizedValue = decodedValue;
    } catch {
      // 保留原值，以便后续格式校验给出准确提示。
    }
  }

  if (!/^otpauth:\/\/totp(?:\/|$)/i.test(normalizedValue)) {
    throw new Error("仅支持 TOTP otpauth 二维码。");
  }

  let url;
  try {
    url = new URL(normalizedValue);
  } catch {
    throw new Error("二维码内容不是有效的 otpauth 链接。");
  }

  const algorithm = (url.searchParams.get("algorithm") || "SHA1").toUpperCase();
  const digits = Number(url.searchParams.get("digits") || 6);
  const period = Number(url.searchParams.get("period") || PERIOD);
  if (algorithm !== "SHA1" || digits !== 6 || period !== PERIOD) {
    throw new Error("目前仅支持 SHA-1、6 位、30 秒的 TOTP。");
  }

  const secret = url.searchParams.get("secret");
  if (!secret) throw new Error("二维码中没有密钥。");
  base32ToBytes(secret);

  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const issuerParam = url.searchParams.get("issuer")?.trim();
  const [labelIssuer, ...labelAccountParts] = label.split(":");
  const hasLabelIssuer = labelAccountParts.length > 0;
  const issuer = issuerParam || (hasLabelIssuer ? labelIssuer : "");
  const account = (hasLabelIssuer ? labelAccountParts.join(":") : label) || "";
  const name = issuerParam && label && !label.startsWith(`${issuerParam}:`)
    ? `${issuerParam}: ${label}`
    : label || issuer;

  return { name, issuer, account, secret };
}

/**
 * 保存账户；若已有相同密钥的账户，则保留现有数据。
 *
 * @param {{name: string, issuer: string, account: string, secret: string}} account 待保存的账户。
 * @returns {Promise<string>} 已保存或已存在账户的名称。
 */
async function saveAccount({ name, issuer, account, secret }) {
  const accounts = (await storageGet(STORAGE_KEY))[STORAGE_KEY] || [];
  const existing = accounts.find((saved) => normalizeSecret(saved.secret) === normalizeSecret(secret));
  if (existing) return existing.name;
  accounts.push({ id: crypto.randomUUID(), name, issuer, account, secret });
  await storageSet({ [STORAGE_KEY]: accounts });
  return name;
}

/**
 * 一次性导入配置 URI 或竖线分隔的账户记录。
 *
 * @param {unknown[]} lines 批量导入表单中的文本行。
 * @returns {Promise<number>} 新保存的账户数量。
 */
async function importAccounts(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new Error("请输入至少一条账户信息。");
  const imported = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    try {
      if (/^otpauth:/i.test(line)) {
        imported.push(parseOtpauth(line));
        continue;
      }

      const [issuer, account, secret, ...extra] = line.split("|").map((part) => part.trim());
      if (extra.length || !secret) {
        throw new Error("格式应为：颁发者 | 账户 | Base32 密钥");
      }
      base32ToBytes(secret);
      imported.push({ name: `${issuer}: ${account}`, issuer, account, secret });
    } catch (error) {
      throw new Error(`第 ${index + 1} 行：${error.message || "格式错误"}`);
    }
  }

  if (!imported.length) throw new Error("没有可导入的账户信息。");
  const accounts = (await storageGet(STORAGE_KEY))[STORAGE_KEY] || [];
  const knownSecrets = new Set(accounts.map((account) => normalizeSecret(account.secret)));
  const newAccounts = imported.filter((account) => {
    const key = normalizeSecret(account.secret);
    if (knownSecrets.has(key)) return false;
    knownSecrets.add(key);
    return true;
  });
  if (newAccounts.length) {
    accounts.push(...newAccounts.map((account) => ({ ...account, id: crypto.randomUUID() })));
    await storageSet({ [STORAGE_KEY]: accounts });
  }
  return newAccounts.length;
}

/**
 * 校验 Base32 密钥后新增一个手动输入的账户。
 *
 * @param {{issuer?: unknown, account?: unknown, secret?: unknown}} input 表单值。
 * @returns {Promise<void>} 完成 Promise。
 */
async function addManualAccount({ issuer, account, secret }) {
  const normalizedIssuer = String(issuer || "").trim();
  const normalizedAccount = String(account || "").trim();
  const normalizedSecret = String(secret || "").trim();
  base32ToBytes(normalizedSecret);

  const accounts = (await storageGet(STORAGE_KEY))[STORAGE_KEY] || [];
  if (accounts.some((saved) => normalizeSecret(saved.secret) === normalizeSecret(normalizedSecret))) {
    throw new Error("该验证器已存在");
  }
  accounts.push({
    id: crypto.randomUUID(),
    name: normalizedIssuer && normalizedAccount ? `${normalizedIssuer}: ${normalizedAccount}` : normalizedIssuer || normalizedAccount,
    issuer: normalizedIssuer,
    account: normalizedAccount,
    secret: normalizedSecret,
  });
  await storageSet({ [STORAGE_KEY]: accounts });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_SCAN") {
    startScan(message.tabId, message.dataUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "无法开始扫码" }));
    return true;
  }

  if (message?.type === "SCAN_RESULT") {
    handleScanResult(message.payload, sender.tab?.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message || "保存失败" }));
    return true;
  }

  if (message?.type === "SCAN_CANCEL") {
    cleanupScan(sender.tab?.id).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "IMPORT_ACCOUNTS") {
    importAccounts(message.lines)
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "导入失败" }));
    return true;
  }

  if (message?.type === "ADD_MANUAL_ACCOUNT") {
    addManualAccount(message.account)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "添加失败" }));
    return true;
  }

  if (message?.type === "FILL_TOTP") {
    fillTotpOnActiveTab(message.code)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "无法填充验证码" }));
    return true;
  }

  return false;
});

/**
 * 注入并显示页面级二维码框选遮罩。
 *
 * @param {number} tabId 目标标签页 ID。
 * @param {string} dataUrl 截图数据 URL。
 * @returns {Promise<void>} 完成 Promise。
 */
async function startScan(tabId, dataUrl) {
  if (!tabId || !dataUrl) throw new Error("缺少扫码所需信息。");

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/jsQR.js", "scan-overlay.js"],
  });

  await chrome.tabs.sendMessage(tabId, {
    type: "SHOW_SCAN_OVERLAY",
    dataUrl,
  });
}

/**
 * 解析并保存已识别的二维码内容。
 *
 * @param {unknown} payload 已识别的二维码文本。
 * @param {number | undefined} tabId 来源标签页 ID。
 * @returns {Promise<{ok: boolean, name?: string, error?: string}>} 返回给遮罩层的结果。
 */
async function handleScanResult(payload, tabId) {
  try {
    const account = parseOtpauth(payload);
    const name = await saveAccount(account);
    return { ok: true, name };
  } catch (error) {
    return { ok: false, error: error.message || "无法识别二维码" };
  }
}

/**
 * 当来源标签页仍可访问时，隐藏扫码遮罩。
 *
 * @param {number | undefined} tabId 目标标签页 ID。
 * @returns {Promise<void>} 完成 Promise。
 */
async function cleanupScan(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "HIDE_SCAN_OVERLAY" });
  } catch {
    // 标签页可能已关闭或无法访问。
  }
}

/**
 * 尝试将复制的验证码填入当前页面匹配的输入框，并尽量自动提交/登录。
 *
 * @param {string} code 6 位 TOTP 验证码。
 * @returns {Promise<{filled: boolean, submitted?: boolean}>} 是否填充、是否提交。
 */
async function fillTotpOnActiveTab(code) {
  if (!/^\d{6}$/.test(code)) throw new Error("验证码格式无效。");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有可用的浏览器标签页。");

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (token) => {
      const notify = (element) => {
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const isVisible = (element) => {
        const style = getComputedStyle(element);
        return !element.disabled && style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
      };
      const buttonText = (element) =>
        `${element.innerText || ""} ${element.value || ""} ${element.getAttribute("aria-label") || ""} ${element.title || ""}`.trim().toLowerCase();
      const trySubmitNear = (anchor) => {
        const form = anchor?.closest?.("form");
        if (form) {
          const submitControl = [...form.querySelectorAll('button, input[type="submit"], input[type="button"]')]
            .filter(isVisible)
            .find((el) => {
              const type = (el.getAttribute("type") || "").toLowerCase();
              const text = buttonText(el);
              if (type === "reset" || /resend|重新发送|cancel|取消|back|返回|forgot/.test(text)) return false;
              return type === "submit" || /submit|verify|confirm|continue|next|login|sign.?in|验证|确认|继续|下一步|登录|确定/.test(text);
            });
          if (submitControl) {
            submitControl.click();
            return true;
          }
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
            return true;
          }
          form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          return true;
        }

        const candidates = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
          .filter(isVisible)
          .filter((el) => {
            const type = (el.getAttribute("type") || "").toLowerCase();
            const text = buttonText(el);
            if (type === "reset" || /resend|重新发送|cancel|取消|back|返回|forgot/.test(text)) return false;
            return type === "submit" || /submit|verify|confirm|continue|next|login|sign.?in|验证|确认|继续|下一步|登录|确定/.test(text);
          });
        if (!candidates.length) return false;
        candidates[0].click();
        return true;
      };

      const inputs = [...document.querySelectorAll("input")].filter(isVisible);
      const digitInputs = inputs.filter((input) => input.maxLength === 1);
      if (digitInputs.length >= token.length) {
        const filledDigits = digitInputs.slice(0, token.length);
        filledDigits.forEach((input, index) => {
          input.focus();
          input.value = token[index];
          notify(input);
        });
        filledDigits[token.length - 1].focus();
        const submitted = trySubmitNear(filledDigits[0]);
        return { filled: true, submitted };
      }

      const codeField = inputs.find((input) => {
        const descriptor = `${input.autocomplete} ${input.name} ${input.id} ${input.placeholder} ${input.className}`.toLowerCase();
        return input.autocomplete === "one-time-code" || /\b(otp|totp|2fa|mfa|verification|verify|code)\b|验证码/.test(descriptor);
      });
      if (!codeField) return { filled: false, submitted: false };
      codeField.focus();
      codeField.value = token;
      notify(codeField);
      const submitted = trySubmitNear(codeField);
      return { filled: true, submitted };
    },
    args: [code],
  });
  return result || { filled: false, submitted: false };
}
