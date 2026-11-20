const crypto = require("node:crypto");

const REQUIRED_SETTINGS = [
  "SEPAY_BANK_CODE",
  "SEPAY_ACCOUNT_NUMBER",
  "SEPAY_ACCOUNT_NAME",
  "SEPAY_WEBHOOK_SECRET",
  "SEPAY_WEBHOOK_URL"
];

function loadSepayConfig(env = process.env) {
  const values = REQUIRED_SETTINGS.map(name => String(env[name] || "").trim());
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) {
    throw new Error("SePay configuration is incomplete. Configure all SEPAY_* values.");
  }

  const [bankCode, accountNumber, accountName, webhookSecret, webhookUrl] = values;
  if (!/^[A-Za-z0-9]{2,20}$/.test(bankCode)) {
    throw new Error("SEPAY_BANK_CODE must contain 2-20 letters or numbers.");
  }
  if (!/^\d{6,20}$/.test(accountNumber)) {
    throw new Error("SEPAY_ACCOUNT_NUMBER must contain 6-20 digits.");
  }
  if (accountName.length < 2 || accountName.length > 100) {
    throw new Error("SEPAY_ACCOUNT_NAME must contain 2-100 characters.");
  }
  if (webhookSecret.length < 32) {
    throw new Error("SEPAY_WEBHOOK_SECRET must contain at least 32 characters.");
  }

  let parsedWebhookUrl;
  try {
    parsedWebhookUrl = new URL(webhookUrl);
  } catch {
    throw new Error("SEPAY_WEBHOOK_URL must be a valid public HTTPS URL.");
  }
  if (
    parsedWebhookUrl.protocol !== "https:" ||
    !parsedWebhookUrl.hostname ||
    parsedWebhookUrl.username ||
    parsedWebhookUrl.password ||
    parsedWebhookUrl.pathname !== "/api/sepay/webhook" ||
    parsedWebhookUrl.search ||
    parsedWebhookUrl.hash
  ) {
    throw new Error("SEPAY_WEBHOOK_URL must be a public HTTPS URL ending in /api/sepay/webhook.");
  }

  return { bankCode, accountNumber, accountName, webhookSecret, webhookUrl };
}

function verifySepaySignature({ authorization, signature, timestamp, rawBody, secret, now = Date.now() }) {
  if (typeof authorization === "string" && typeof secret === "string" && secret.length >= 32) {
    const match = authorization.trim().match(/^Apikey\s+(.+)$/i);
    if (match) {
      const suppliedKey = Buffer.from(match[1].trim(), "utf8");
      const expectedKey = Buffer.from(secret, "utf8");
      if (suppliedKey.length === expectedKey.length && crypto.timingSafeEqual(suppliedKey, expectedKey)) {
        return true;
      }
    }
  }

  if (
    typeof signature !== "string" ||
    typeof timestamp !== "string" ||
    !Buffer.isBuffer(rawBody) ||
    !/^\d{10}$/.test(timestamp) ||
    !/^sha256=[a-f0-9]{64}$/i.test(signature)
  ) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(now / 1000) - timestampSeconds) > 300) {
    return false;
  }

  const expected = crypto.createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(signature.slice("sha256=".length), "hex");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function parseSepayTransaction(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = String(payload.id ?? "");
  const accountNumber = String(payload.accountNumber ?? "");
  const content = typeof payload.content === "string" ? payload.content.trim() : "";
  const transferType = payload.transferType;
  const transferAmount = payload.transferAmount;

  if (!/^\d{1,20}$/.test(id)) return null;
  if (!/^\d{6,20}$/.test(accountNumber)) return null;
  if (!content || content.length > 1000) return null;
  if (transferType !== "in" && transferType !== "out") return null;
  if (!Number.isSafeInteger(transferAmount) || transferAmount <= 0) return null;

  return { id, accountNumber, content, transferType, transferAmount };
}

function containsTransferReference(content, reference) {
  if (typeof content !== "string" || typeof reference !== "string" || !reference) return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, "i").test(content);
}

function createSepayQrUrl(config, { amount, reference }) {
  const description = /^SEVQR(\s|$)/i.test(reference) ? reference : `SEVQR ${reference}`;
  const query = new URLSearchParams({
    acc: config.accountNumber,
    bank: config.bankCode,
    amount: String(amount),
    des: description,
    template: "compact",
    showinfo: "true",
    holder: config.accountName,
    store: "GTN GAMING SHOP"
  });
  return `https://vietqr.app/img?${query.toString()}`;
}

function processSepayTransaction(db, config, transaction) {
  if (transaction.accountNumber !== config.accountNumber || transaction.transferType !== "in") {
    return { success: false, reason: "account_or_direction_mismatch" };
  }

  const duplicate = db.topups.find(t =>
    t.method === "SePay" && t.sepayTransactionId === transaction.id
  );
  if (duplicate) {
    const sameReference = containsTransferReference(transaction.content, duplicate.bankReference);
    return {
      success: duplicate.status === "paid" && sameReference,
      duplicate: duplicate.status === "paid" && sameReference,
      reason: "duplicate_transaction"
    };
  }

  const topup = db.topups.find(t =>
    t.method === "SePay" &&
    t.status === "pending" &&
    containsTransferReference(transaction.content, t.bankReference)
  );
  if (!topup) return { success: false, reason: "no_matching_pending_topup" };
  if (topup.amount !== transaction.transferAmount) {
    return { success: false, reason: "amount_mismatch" };
  }
  const user = db.users.find(entry => entry.id === topup.userId);
  if (!user) return { success: false, reason: "customer_not_found" };

  const balance = Number(user.balance);
  if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isSafeInteger(balance + topup.amount)) {
    return { success: false, reason: "invalid_customer_balance" };
  }

  topup.status = "paid";
  topup.transactionNo = transaction.id;
  topup.sepayTransactionId = transaction.id;
  topup.bankCode = config.bankCode;
  topup.paidAt = new Date().toISOString();
  user.balance = balance + topup.amount;
  return { success: true, processed: true };
}

module.exports = {
  containsTransferReference,
  createSepayQrUrl,
  loadSepayConfig,
  parseSepayTransaction,
  processSepayTransaction,
  verifySepaySignature
};