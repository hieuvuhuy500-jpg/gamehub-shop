const assert = require("node:assert/strict");
const test = require("node:test");
const { createVnpayPaymentUrl, loadVnpayConfig, verifyVnpaySignature } = require("../lib/vnpay");

const config = loadVnpayConfig({
  VNPAY_TMN_CODE: "ABCD1234",
  VNPAY_HASH_SECRET: "test-secret",
  VNPAY_PAYMENT_URL: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  VNPAY_RETURN_URL: "https://shop.example.test/nap-tien/ket-qua",
  VNPAY_IPN_URL: "https://shop.example.test/api/vnpay/ipn"
});

test("payment URL has a valid signature and expected amount", () => {
  const paymentUrl = new URL(createVnpayPaymentUrl(config, {
    amount: 125000,
    txnRef: "abcdef123456",
    ipAddr: "127.0.0.1"
  }));
  const params = Object.fromEntries(paymentUrl.searchParams.entries());

  assert.equal(paymentUrl.origin + paymentUrl.pathname, config.paymentUrl);
  assert.equal(params.vnp_Amount, "12500000");
  assert.equal(params.vnp_TxnRef, "abcdef123456");
  assert.equal(verifyVnpaySignature(params, config.hashSecret), true);
  assert.equal(verifyVnpaySignature({ ...params, vnp_Amount: "1" }, config.hashSecret), false);
});

test("callback verification ignores hash metadata but rejects parameter arrays", () => {
  const url = new URL(createVnpayPaymentUrl(config, {
    amount: 10000,
    txnRef: "test-order",
    ipAddr: "127.0.0.1"
  }));
  const params = Object.fromEntries(url.searchParams.entries());

  assert.equal(verifyVnpaySignature({ ...params, vnp_SecureHashType: "HMACSHA512" }, config.hashSecret), true);
  assert.equal(verifyVnpaySignature({ ...params, vnp_Amount: ["1000000"] }, config.hashSecret), false);
});

test("VNPay configuration fails closed when incomplete or not HTTPS", () => {
  assert.equal(loadVnpayConfig({}), null);
  assert.throws(() => loadVnpayConfig({ VNPAY_TMN_CODE: "ABCD1234" }), /incomplete/i);
  assert.throws(() => loadVnpayConfig({
    VNPAY_TMN_CODE: "ABCD1234",
    VNPAY_HASH_SECRET: "test-secret",
    VNPAY_PAYMENT_URL: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
    VNPAY_RETURN_URL: "http://localhost/return",
    VNPAY_IPN_URL: "https://shop.example.test/api/vnpay/ipn"
  }), /HTTPS/i);
});
