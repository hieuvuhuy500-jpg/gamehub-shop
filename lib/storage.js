const fs = require("fs");
const path = require("path");

const EMPTY_DB = { users: [], products: [], orders: [], topups: [], gameCategories: [] };

function normalizeDb(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (!Array.isArray(data.users) || !Array.isArray(data.products) || !Array.isArray(data.orders) || !Array.isArray(data.topups)) {
    return null;
  }
  return {
    users: data.users,
    products: data.products,
    orders: data.orders,
    topups: data.topups,
    gameCategories: Array.isArray(data.gameCategories) ? data.gameCategories : []
  };
}

function atomicWrite(filePath, serialized) {
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempFile, serialized, "utf8");
    fs.renameSync(tempFile, filePath);
  } catch {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch {}
    }
    fs.writeFileSync(filePath, serialized, "utf8");
  }
}

function createStorage(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dbFile = path.join(dataDir, "db.json");
  const backupFile = path.join(dataDir, "db.backup.json");
  const cloudUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
  const cloudToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
  const cloudKey = String(process.env.UPSTASH_DB_KEY || "gamehub:db:v1").trim();
  const cloudEnabled = Boolean(cloudUrl && cloudToken && typeof fetch === "function");

  let lastValidSerialized = "";
  let syncChain = Promise.resolve();

  function readFileSafe(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = normalizeDb(JSON.parse(raw));
      return parsed ? { db: parsed, raw } : null;
    } catch {
      return null;
    }
  }

  function ensureLocalFile() {
    const primary = readFileSafe(dbFile);
    if (primary) {
      lastValidSerialized = primary.raw;
      if (!fs.existsSync(backupFile)) atomicWrite(backupFile, primary.raw);
      return primary.db;
    }
    const backup = readFileSafe(backupFile);
    if (backup) {
      console.warn("[Storage] File db.json bi loi, da tu dong khoi phuc tu db.backup.json.");
      atomicWrite(dbFile, backup.raw);
      lastValidSerialized = backup.raw;
      return backup.db;
    }
    const initial = JSON.stringify(EMPTY_DB, null, 2);
    atomicWrite(dbFile, initial);
    atomicWrite(backupFile, initial);
    lastValidSerialized = initial;
    return JSON.parse(initial);
  }

  async function cloudCommand(command) {
    if (!cloudEnabled) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(cloudUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cloudToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`Cloud HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function queueCloudSync(serialized) {
    if (!cloudEnabled) return Promise.resolve();
    syncChain = syncChain
      .then(() => cloudCommand(["SET", cloudKey, serialized]))
      .catch(error => {
        console.error("[Storage] Dong bo dam may that bai:", error.message);
      });
    return syncChain;
  }

  function readDB() {
    const primary = readFileSafe(dbFile);
    if (primary) {
      lastValidSerialized = primary.raw;
      return primary.db;
    }
    const backup = readFileSafe(backupFile);
    if (backup) {
      console.warn("[Storage] Tu dong phuc hoi db.json tu ban sao du phong.");
      atomicWrite(dbFile, backup.raw);
      lastValidSerialized = backup.raw;
      return backup.db;
    }
    if (lastValidSerialized) {
      atomicWrite(dbFile, lastValidSerialized);
      return JSON.parse(lastValidSerialized);
    }
    return ensureLocalFile();
  }

  function writeDB(db) {
    const clean = normalizeDb(db);
    if (!clean) throw new Error("Du lieu DB khong hop le, tu choi ghi de.");
    const serialized = JSON.stringify(clean, null, 2);
    atomicWrite(dbFile, serialized);
    atomicWrite(backupFile, serialized);
    lastValidSerialized = serialized;
    queueCloudSync(serialized);
  }

  async function initStorage() {
    ensureLocalFile();
    if (!cloudEnabled) {
      console.warn("[Storage] Chua cau hinh UPSTASH_REDIS_REST_URL/TOKEN - du lieu chi luu cuc bo.");
      return;
    }
    try {
      const response = await cloudCommand(["GET", cloudKey]);
      if (response && typeof response.result === "string" && response.result.trim()) {
        const remoteDb = normalizeDb(JSON.parse(response.result));
        if (remoteDb) {
          const serialized = JSON.stringify(remoteDb, null, 2);
          atomicWrite(dbFile, serialized);
          atomicWrite(backupFile, serialized);
          lastValidSerialized = serialized;
          console.log(
            `[Storage] Da khoi phuc du lieu tu dam may (${remoteDb.users.length} tai khoan, ${remoteDb.products.length} mat hang, ${remoteDb.orders.length} don hang).`
          );
          return;
        }
      }
      await cloudCommand(["SET", cloudKey, lastValidSerialized]);
      console.log("[Storage] Da khoi tao ban sao luu dau tien len dam may.");
    } catch (error) {
      console.error("[Storage] Khong doc duoc ban sao dam may khi khoi dong:", error.message);
    }
  }

  async function flushBeforeExit(reason) {
    console.warn(`[Storage] Dang luu khan cap du lieu truoc khi dung (${reason})...`);
    if (lastValidSerialized) {
      try {
        atomicWrite(dbFile, lastValidSerialized);
        atomicWrite(backupFile, lastValidSerialized);
      } catch {}
    }
    if (cloudEnabled && lastValidSerialized) {
      try {
        await queueCloudSync(lastValidSerialized);
        console.log("[Storage] Da luu an toan toan bo kho hang va vi khach len dam may.");
      } catch {}
    }
  }

  return {
    cloudEnabled,
    flushBeforeExit,
    initStorage,
    normalizeDb,
    readDB,
    writeDB
  };
}

module.exports = { createStorage };