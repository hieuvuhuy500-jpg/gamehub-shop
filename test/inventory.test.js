const assert = require("node:assert/strict");
const test = require("node:test");
const { appendAccounts, findMatchingProduct } = require("../lib/inventory");

test("matching product inventory is appended without replacing existing accounts", () => {
  const currentAccount = { ciphertext: "existing-account" };
  const addedAccount = { ciphertext: "new-account" };
  const product = {
    game: "Liên Quân",
    name: "Tài khoản rank cao",
    accounts: [currentAccount],
    status: "available"
  };

  assert.equal(appendAccounts(product, [addedAccount]), 2);
  assert.deepEqual(product.accounts, [currentAccount, addedAccount]);
  assert.equal(product.status, "available");
});

test("matching uses game and product name, ignoring case, accents, and extra spaces", () => {
  const product = { game: "Liên Quân", name: "Tài khoản Rank Cao" };

  assert.equal(findMatchingProduct([product], "lien   quan", "tai khoan rank cao"), product);
  assert.equal(findMatchingProduct([product], "Roblox", "Tài khoản Rank Cao"), undefined);
  assert.equal(findMatchingProduct([product], "Liên Quân", "Tài khoản khác"), undefined);
});
