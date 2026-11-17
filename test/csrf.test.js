const assert = require("node:assert/strict");
const test = require("node:test");
const { isSameOriginRequest } = require("../lib/csrf");

test("same-origin login recovery accepts the current HTTP or HTTPS host", () => {
  assert.equal(isSameOriginRequest("http://192.168.1.50:3000", "192.168.1.50:3000"), true);
  assert.equal(isSameOriginRequest(undefined, "192.168.1.50:3000"), false);
  assert.equal(isSameOriginRequest("https://shop.example.test/login", "shop.example.test"), true);
  assert.equal(isSameOriginRequest(undefined, "shop.example.test"), false);
});

test("same-origin login recovery rejects cross-origin and invalid sources", () => {
  assert.equal(isSameOriginRequest("https://attacker.example", "shop.example.test"), false);
  assert.equal(isSameOriginRequest("not a URL", "shop.example.test"), false);
  assert.equal(isSameOriginRequest("ftp://shop.example.test", "shop.example.test"), false);
});
