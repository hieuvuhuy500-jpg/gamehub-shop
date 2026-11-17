const assert = require("node:assert/strict");
const test = require("node:test");
const { decryptAccount, encryptAccount, getDeliveryKey, parseAccountEntries } = require("../lib/delivery");

const env = { DELIVERY_ENCRYPTION_KEY: "ab".repeat(32) };

test("account inventory is encrypted at rest and decrypts for the buyer", () => {
  const account = { username: "buyer@example.test", password: "pass|word-123" };
  const encrypted = encryptAccount(account, env);

  assert.equal(JSON.stringify(encrypted).includes(account.password), false);
  assert.deepEqual(decryptAccount(encrypted, env), account);
  assert.throws(() => decryptAccount({ ...encrypted, ciphertext: "AA==" }, env));
});

test("inventory parser validates username/password lines", () => {
  assert.deepEqual(parseAccountEntries("user@example.test|pass|word\nsecond|secret"), [
    { username: "user@example.test", password: "pass|word" },
    { username: "second", password: "secret" }
  ]);
  assert.deepEqual(parseAccountEntries(" \n "), []);
  assert.throws(() => parseAccountEntries("invalid-line"), /line 1/i);
  assert.throws(() => getDeliveryKey({}), /32-byte/i);
});
