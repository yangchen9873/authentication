(() => {
  const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  /**
   * 规范化用户输入的 Base32 密钥，但不进行有效性校验。
   *
   * @param {unknown} secret 原始密钥值。
   * @returns {string} 转为大写并移除填充符后的 Base32 候选值。
   */
  function normalizeSecret(secret) {
    return String(secret || "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  }

  /**
   * 将 Base32 密钥转换为 Web Crypto 所需的字节数组。
   *
   * @param {unknown} secret Base32 密钥。
   * @returns {Uint8Array} 密钥字节数组。
   * @throws {Error} 当密钥为空或含有非法字符时抛出异常。
   */
  function base32ToBytes(secret) {
    const normalized = normalizeSecret(secret);
    if (!/^[A-Z2-7]+$/.test(normalized)) {
      throw new Error("密钥必须是有效的 Base32 字符串。");
    }

    let bits = "";
    for (const char of normalized) {
      bits += BASE32_ALPHABET.indexOf(char).toString(2).padStart(5, "0");
    }

    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }
    if (!bytes.length) throw new Error("密钥不能为空。");
    return new Uint8Array(bytes);
  }

  /**
   * 生成 SHA-1、6 位、30 秒周期的 TOTP 验证码。
   *
   * @param {string} secret Base32 密钥。
   * @param {number} [timestamp=Date.now()] 毫秒级 Unix 时间戳。
   * @returns {Promise<string>} 6 位验证码。
   */
  async function generateTotp(secret, timestamp = Date.now()) {
    const counter = Math.floor(timestamp / 30_000);
    const counterBuffer = new ArrayBuffer(8);
    new DataView(counterBuffer).setUint32(4, counter, false);

    const key = await crypto.subtle.importKey(
      "raw",
      base32ToBytes(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBuffer));
    const offset = signature[signature.length - 1] & 0x0f;
    const value = (
      ((signature[offset] & 0x7f) << 24)
      | (signature[offset + 1] << 16)
      | (signature[offset + 2] << 8)
      | signature[offset + 3]
    ) >>> 0;

    return String(value % 1_000_000).padStart(6, "0");
  }

  globalThis.AuthenticatorTOTP = { base32ToBytes, generateTotp, normalizeSecret };
})();
