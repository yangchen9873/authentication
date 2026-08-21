(() => {
  if (window.__authenticatorScanInstalled) return;
  window.__authenticatorScanInstalled = true;

  const ROOT_ID = "authenticator-scan-root";
  let root = null;
  let selecting = false;
  let startX = 0;
  let startY = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_SCAN_OVERLAY") {
      showOverlay(message.dataUrl)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "HIDE_SCAN_OVERLAY") {
      hideOverlay();
      sendResponse({ ok: true });
    }
    return false;
  });

  /**
   * 创建用于框选二维码的全屏截图遮罩。
   *
   * @param {string} dataUrl 页面截图数据。
   * @returns {Promise<void>} 完成 Promise。
   */
  async function showOverlay(dataUrl) {
    hideOverlay();

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <style>
        #${ROOT_ID} {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
          font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        }
        #${ROOT_ID} * { box-sizing: border-box; }
        #${ROOT_ID} .auth-scan-backdrop {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: fill;
          cursor: crosshair;
          user-select: none;
          -webkit-user-drag: none;
        }
        #${ROOT_ID} .auth-scan-mask {
          position: absolute;
          inset: 0;
          background: rgba(10, 12, 20, 0.45);
          pointer-events: none;
        }
        #${ROOT_ID} .auth-scan-selection {
          position: absolute;
          border: 2px solid #7a88ff;
          box-shadow: 0 0 0 9999px rgba(10, 12, 20, 0.5);
          background: transparent;
          display: none;
          pointer-events: none;
        }
        #${ROOT_ID} .auth-scan-hint {
          position: absolute;
          top: 20px;
          left: 50%;
          transform: translateX(-50%);
          padding: 10px 14px;
          border-radius: 999px;
          background: rgba(20, 23, 31, 0.92);
          color: #e7e9f2;
          font-size: 13px;
          white-space: nowrap;
          pointer-events: none;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        }
        #${ROOT_ID} .auth-scan-toast {
          position: absolute;
          left: 50%;
          bottom: 28px;
          transform: translateX(-50%);
          max-width: min(420px, calc(100vw - 32px));
          padding: 10px 14px;
          border-radius: 12px;
          background: rgba(20, 23, 31, 0.94);
          color: #e7e9f2;
          font-size: 13px;
          text-align: center;
          display: none;
          pointer-events: none;
        }
        #${ROOT_ID} .auth-scan-toast.is-error { background: rgba(120, 28, 36, 0.95); }
        #${ROOT_ID} .auth-scan-toast.is-ok { background: rgba(24, 96, 72, 0.95); }
      </style>
      <img class="auth-scan-backdrop" alt="" draggable="false" />
      <div class="auth-scan-mask"></div>
      <div class="auth-scan-selection"></div>
      <div class="auth-scan-hint">拖动鼠标框选二维码，按 Esc 取消</div>
      <div class="auth-scan-toast" role="status"></div>
    `;

    const img = root.querySelector(".auth-scan-backdrop");
    img.src = dataUrl;
    await img.decode();

    document.documentElement.append(root);
    document.addEventListener("keydown", onKeyDown, true);

    img.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  }

  /**
   * 移除遮罩及其全局事件监听器。
   */
  function hideOverlay() {
    selecting = false;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    root?.remove();
    root = null;
  }

  /**
   * @param {KeyboardEvent} event 页面键盘事件。
   */
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hideOverlay();
      chrome.runtime.sendMessage({ type: "SCAN_CANCEL" });
    }
  }

  /**
   * @param {MouseEvent} event 二维码框选开始事件。
   */
  function onMouseDown(event) {
    if (event.button !== 0 || !root) return;
    event.preventDefault();
    selecting = true;
    startX = event.clientX;
    startY = event.clientY;
    const selection = root.querySelector(".auth-scan-selection");
    const mask = root.querySelector(".auth-scan-mask");
    mask.style.display = "none";
    selection.style.display = "block";
    updateSelection(startX, startY, startX, startY);
    showToast("");
  }

  /**
   * @param {MouseEvent} event 二维码框选移动事件。
   */
  function onMouseMove(event) {
    if (!selecting || !root) return;
    updateSelection(startX, startY, event.clientX, event.clientY);
  }

  /**
   * @param {MouseEvent} event 二维码框选结束事件。
   */
  async function onMouseUp(event) {
    if (!selecting || !root || event.button !== 0) return;
    selecting = false;

    const x1 = Math.min(startX, event.clientX);
    const y1 = Math.min(startY, event.clientY);
    const x2 = Math.max(startX, event.clientX);
    const y2 = Math.max(startY, event.clientY);
    const width = x2 - x1;
    const height = y2 - y1;

    if (width < 12 || height < 12) {
      closeAndAlert("框选区域太小，已取消扫码。");
      return;
    }

    try {
      const text = await decodeSelection(x1, y1, width, height);
      const response = await chrome.runtime.sendMessage({
        type: "SCAN_RESULT",
        payload: text,
      });

      if (response?.ok) {
        showToast(`已添加：${response.name}`, "ok");
        setTimeout(() => hideOverlay(), 900);
      } else {
        closeAndAlert(response?.error || "无法添加二维码，已取消扫码。");
      }
    } catch (error) {
      closeAndAlert(error?.message || "二维码识别失败，已取消扫码。");
    }
  }

  /**
   * 关闭遮罩，并通知后台扫码已结束。
   */
  function exitScan() {
    hideOverlay();
    chrome.runtime.sendMessage({ type: "SCAN_CANCEL" });
  }

  /**
   * 先关闭遮罩再显示错误，避免提示被遮罩层挡住。
   *
   * @param {string} message 错误提示文本。
   */
  function closeAndAlert(message) {
    exitScan();
    window.setTimeout(() => window.alert(message), 0);
  }

  /**
   * 使用视口坐标绘制当前框选区域。
   *
   * @param {number} x1 起点 x 坐标。
   * @param {number} y1 起点 y 坐标。
   * @param {number} x2 终点 x 坐标。
   * @param {number} y2 终点 y 坐标。
   */
  function updateSelection(x1, y1, x2, y2) {
    const selection = root.querySelector(".auth-scan-selection");
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    selection.style.left = `${left}px`;
    selection.style.top = `${top}px`;
    selection.style.width = `${Math.abs(x2 - x1)}px`;
    selection.style.height = `${Math.abs(y2 - y1)}px`;
  }

  /**
   * 显示短暂的遮罩层状态提示。
   *
   * @param {string} message 提示文本。
   * @param {"ok" | "error" | undefined} type 提示视觉类型。
   */
  function showToast(message, type) {
    if (!root) return;
    const toast = root.querySelector(".auth-scan-toast");
    toast.textContent = message || "";
    toast.classList.remove("is-error", "is-ok");
    if (!message) {
      toast.style.display = "none";
      return;
    }
    if (type) toast.classList.add(`is-${type}`);
    toast.style.display = "block";
  }

  /**
   * 将视口框选区域映射回截图像素并识别二维码。
   *
   * @param {number} x 框选区域 x 坐标。
   * @param {number} y 框选区域 y 坐标。
   * @param {number} width 框选区域宽度。
   * @param {number} height 框选区域高度。
   * @returns {Promise<string>} 已识别的二维码内容。
   */
  async function decodeSelection(x, y, width, height) {
    const img = root.querySelector(".auth-scan-backdrop");
    const scaleX = img.naturalWidth / window.innerWidth;
    const scaleY = img.naturalHeight / window.innerHeight;

    const sx = Math.round(x * scaleX);
    const sy = Math.round(y * scaleY);
    const sw = Math.max(1, Math.round(width * scaleX));
    const sh = Math.max(1, Math.round(height * scaleY));

    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const imageData = ctx.getImageData(0, 0, sw, sh);

    if (typeof jsQR !== "function") {
      throw new Error("二维码识别库未加载。");
    }

    const result = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });

    if (!result?.data) throw new Error("未识别到二维码，请重新框选。");
    return result.data.trim();
  }
})();
