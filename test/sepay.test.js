const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const {
  containsTransferReference,
  createSepayQrUrl,
  loadSepayConfig,
  parseSepayTransaction,
  processSepayTransaction,
  verifySepaySignature
} = require("../lib/sepay");

const webhookSecret = "a".repeat(64);
const config = loadSepayConfig({
  SEPAY_BANK_CODE: "VCB",
  SEPAY_ACCOUNT_NUMBER: "0123456789",
  SEPAY_ACCOUNT_NAME: "GTN Gaming Store",
  SEPAY_WEBHOOK_SECRET: webhookSecret,
  SEPAY_WEBHOOK_URL: "https://shop.example.test/api/sepay/webhook"
});

test("SePay configuration requires account details, a strong key, and a public HTTPS webhook URL", () => {
  assert.equal(loadSepayConfig({}), null);
  assert.throws(() => loadSepayConfig({ SEPAY_BANK_CODE: "VCB" }), /incomplete/i);
  assert.throws(() => loadSepayConfig({
    SEPAY_BANK_CODE: "VCB",
    SEPAY_ACCOUNT_NUMBER: "0123456789",
    SEPAY_ACCOUNT_NAME: "GTN Gaming Store",
    SEPAY_WEBHOOK_SECRET: webhookSecret,
    SEPAY_WEBHOOK_URL: "http://localhost/api/sepay/webhook"
  }), /HTTPS/i);
});

test("SePay HMAC verification rejects tampered and stale webhooks", () => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const rawBody = Buffer.from('{"id":92704}');
  const digest = crypto.createHmac("sha256", webhookSecret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  const request = {
    signature: `sha256=${digest}`,
    timestamp,
    rawBody,
    secret: webhookSecret
  };

  assert.equal(verifySepaySignature(request), true);
  assert.equal(verifySepaySignature({ ...request, rawBody: Buffer.from('{"id":92705}') }), false);
  assert.equal(verifySepaySignature({
    ...request,
    timestamp: String(Number(timestamp) - 301)
  }), false);
  assert.equal(verifySepaySignature({ ...request, signature: "invalid" }), false);
});

test("SePay transaction parser rejects malformed and non-object payloads", () => {
  const valid = {
    id: 92704,
    accountNumber: "0123456789",
    content: "Payment GTNABC123",
    transferType: "in",
    transferAmount: 50000
  };
  assert.deepEqual(parseSepayTransaction(valid), { ...valid, id: "92704" });
  assert.equal(parseSepayTransaction(null), null);
  assert.equal(parseSepayTransaction({ ...valid, transferAmount: "50000" }), null);
  assert.equal(parseSepayTransaction({ ...valid, content: "" }), null);
});

test("bank references must match as whole tokens", () => {
  assert.equal(containsTransferReference("PAY GTNABC123 OK", "GTNABC123"), true);
  assert.equal(containsTransferReference("PAY XGTNABC123 OK", "GTNABC123"), false);
});

test("SePay credits only a matching pending top-up and is idempotent", () => {
  const db = {
    users: [{ id: 7, balance: 1000 }],
    topups: [{
      id: "topup-1",
      userId: 7,
      amount: 50000,
      method: "SePay",
      status: "pending",
      bankReference: "GTNABC123"
    }]
  };
  const transaction = {
    id: "92704",
    accountNumber: config.accountNumber,
    content: "PAY GTNABC123",
    transferType: "in",
    transferAmount: 50000
  };

  assert.deepEqual(processSepayTransaction(db, config, transaction), { success: true, processed: true });
  assert.equal(db.users[0].balance, 51000);
  assert.equal(db.topups[0].status, "paid");
  assert.equal(processSepayTransaction(db, config, transaction).duplicate, true);
  assert.equal(db.users[0].balance, 51000);
});

test("wrong account, amount, or reference never credits a wallet", () => {
  const db = {
    users: [{ id: 7, balance: 1000 }],
    topups: [{
      id: "topup-1",
      userId: 7,
      amount: 50000,
      method: "SePay",
      status: "pending",
      bankReference: "GTNABC123"
    }]
  };
  const transaction = {
    id: "92705",
    accountNumber: config.accountNumber,
    content: "PAY GTNABC123",
    transferType: "in",
    transferAmount: 49000
  };

  assert.equal(processSepayTransaction(db, config, transaction).reason, "amount_mismatch");
  assert.equal(processSepayTransaction(db, config, {
    ...transaction,
    id: "92706",
    accountNumber: "9999999999",
    transferAmount: 50000
  }).success, false);
  assert.equal(processSepayTransaction(db, config, {
    ...transaction,
    id: "92707",
    content: "PAY GTNOTHER1",
    transferAmount: 50000
  }).reason, "no_matching_pending_topup");
  assert.equal(db.users[0].balance, 1000);
  assert.equal(db.topups[0].status, "pending");
});

test("VietQR URL includes the exact amount and transfer reference", () => {
  const qrUrl = new URL(createSepayQrUrl(config, { amount: 50000, reference: "GTNABC123" }));
  assert.equal(qrUrl.origin, "https://vietqr.app");
  assert.equal(qrUrl.searchParams.get("amount"), "50000");
  assert.equal(qrUrl.searchParams.get("des"), "GTNABC123");
  assert.equal(qrUrl.searchParams.get("acc"), config.accountNumber);
});
