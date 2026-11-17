const crypto = require("node:crypto");

const PAYMENT_URLS = new Set([
  "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  "https://pay.vnpay.vn/vpcpay.html"
]);

function loadVnpayConfig(env = process.env) {
  const names = [
    "VNPAY_TMN_CODE",
    "VNPAY_HASH_SECRET",
    "VNPAY_PAYMENT_URL",
    "VNPAY_RETURN_URL",
    "VNPAY_IPN_URL"
  ];
  const values = names.map(name => String(env[name] || "").trim());
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) {
    throw new Error("VNPAY configuration is incomplete. Configure all VNPAY_* values.");
  }

  const [tmnCode, hashSecret, paymentUrl, returnUrl, ipnUrl] = values;
  if (!/^[A-Za-z0-9]{8}$/.test(tmnCode)) {
    throw new Error("VNPAY_TMN_CODE must be an 8-character merchant code.");
  }
  if (!PAYMENT_URLS.has(paymentUrl)) {
    throw new Error("VNPAY_PAYMENT_URL must be an official VNPAY payment URL.");
  }
  for (const callbackUrl of [returnUrl, ipnUrl]) {
    let parsed;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      throw new Error("VNPAY return and IPN URLs must be valid HTTPS URLs.");
    }
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      throw new Error("VNPAY return and IPN URLs must use HTTPS.");
    }
  }
  return { tmnCode, hashSecret, paymentUrl, returnUrl, ipnUrl };
}

function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(/%20/g, "+");
}

function createSignedData(params) {
  return Object.keys(params)
    .filter(key => key.startsWith("vnp_") && key !== "vnp_SecureHash" && key !== "vnp_SecureHashType")
    .sort()
    .map(key => `${encodeValue(key)}=${encodeValue(params[key])}`)
    .join("&");
}

function createVnpayPaymentUrl(config, { amount, txnRef, ipAddr }) {
  const now = Date.now();
  const vnTime = timestamp => new Date(timestamp + 7 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const params = {
    vnp_Version: "2.1.0",
    vnp_Command: "pay",
    vnp_TmnCode: config.tmnCode,
    vnp_Amount: String(amount * 100),
    vnp_CurrCode: "VND",
    vnp_TxnRef: txnRef,
    vnp_OrderInfo: `Nap tien GTN ${txnRef}`,
    vnp_OrderType: "other",
    vnp_Locale: "vn",
    vnp_ReturnUrl: config.returnUrl,
    vnp_IpAddr: String(ipAddr || "127.0.0.1").slice(0, 45),
    vnp_CreateDate: vnTime(now),
    vnp_ExpireDate: vnTime(now + 15 * 60 * 1000)
  };
  const signedData = createSignedData(params);
  const secureHash = crypto.createHmac("sha512", config.hashSecret).update(signedData).digest("hex");
  return `${config.paymentUrl}?${signedData}&vnp_SecureHash=${secureHash}`;
}

function verifyVnpaySignature(query, hashSecret) {
  if (!query || typeof query !== "object" || typeof query.vnp_SecureHash !== "string") return false;
  if (!/^[a-f0-9]{128}$/i.test(query.vnp_SecureHash)) return false;
  if (Object.values(query).some(value => typeof value !== "string")) return false;

  const signedData = createSignedData(query);
  const expected = crypto.createHmac("sha512", hashSecret).update(signedData).digest();
  const received = Buffer.from(query.vnp_SecureHash, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

module.exports = { createVnpayPaymentUrl, loadVnpayConfig, verifyVnpaySignature };
