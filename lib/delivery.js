const crypto = require("node:crypto");

function getDeliveryKey(env = process.env) {
  const value = String(env.DELIVERY_ENCRYPTION_KEY || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("DELIVERY_ENCRYPTION_KEY must be a 32-byte hexadecimal key.");
  }
  return Buffer.from(value, "hex");
}

function parseAccountEntries(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 100) throw new Error("Add no more than 100 accounts at a time.");
  return lines.map((line, index) => {
    const separator = line.indexOf("|");
    if (separator <= 0 || separator === line.length - 1) {
      throw new Error(`Account line ${index + 1} must use username|password format.`);
    }
    const username = line.slice(0, separator).trim();
    const password = line.slice(separator + 1).trim();
    if (!username || username.length > 254 || !password || password.length > 512) {
      throw new Error(`Account line ${index + 1} has invalid username or password length.`);
    }
    return { username, password };
  });
}

function encryptAccount(account, env = process.env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getDeliveryKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(account), "utf8"),
    cipher.final()
  ]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decryptAccount(encrypted, env = process.env) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getDeliveryKey(env),
    Buffer.from(encrypted.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

module.exports = { decryptAccount, encryptAccount, getDeliveryKey, parseAccountEntries };
