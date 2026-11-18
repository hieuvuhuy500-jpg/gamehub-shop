const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const FileSessionStore = require("../lib/session-store");

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test("remembered sessions survive store recreation and are removed on logout", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gamehub-session-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const options = { directory, ttlMs: 60000, secret: "test-session-secret" };
  const sessionId = "test-session-id";
  const sessionData = {
    cookie: { originalMaxAge: 60000, expires: new Date(Date.now() + 60000).toISOString() },
    user: { id: 123 }
  };
  const firstStore = new FileSessionStore(options);
  await callStore(firstStore, "set", sessionId, sessionData);

  const restartedStore = new FileSessionStore(options);
  const loadedSession = await callStore(restartedStore, "get", sessionId);
  assert.deepEqual(loadedSession.user, sessionData.user);
  const sessionFile = path.join(directory, fs.readdirSync(directory)[0]);
  assert.equal(fs.readFileSync(sessionFile, "utf8").includes('"id":123'), false);

  const updatedSession = { ...sessionData, user: { id: 456 } };
  await callStore(restartedStore, "touch", sessionId, updatedSession);
  assert.deepEqual((await callStore(new FileSessionStore(options), "get", sessionId)).user, updatedSession.user);

  await callStore(restartedStore, "destroy", sessionId);
  assert.equal(await callStore(restartedStore, "get", sessionId), null);

  const expiredId = "expired-session-id";
  await callStore(restartedStore, "set", expiredId, {
    cookie: { expires: new Date(Date.now() - 1000).toISOString() },
    user: { id: 789 }
  });
  assert.equal(await callStore(restartedStore, "get", expiredId), null);
});
