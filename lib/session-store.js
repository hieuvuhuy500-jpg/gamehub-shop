const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const session = require("express-session");

class FileSessionStore extends session.Store {
  constructor({ directory, secret, ttlMs }) {
    super();
    if (!directory || !secret || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("File session store requires a directory, secret, and positive TTL.");
    }
    this.directory = directory;
    this.ttlMs = ttlMs;
    this.key = crypto.scryptSync(secret, "gamehub-session-store", 32);
    fs.mkdirSync(directory, { recursive: true });
  }

  getSessionPath(sessionId) {
    const fileName = crypto.createHash("sha256").update(String(sessionId)).digest("hex");
    return path.join(this.directory, `${fileName}.json`);
  }

  get(sessionId, callback) {
    const filePath = this.getSessionPath(sessionId);
    fs.readFile(filePath, "utf8", (readError, contents) => {
      if (readError) {
        return callback(readError.code === "ENOENT" ? null : readError, null);
      }

      let session;
      try {
        const record = JSON.parse(contents);
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this.key,
          Buffer.from(record.iv, "base64")
        );
        decipher.setAuthTag(Buffer.from(record.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(record.data, "base64")),
          decipher.final()
        ]).toString("utf8");
        session = JSON.parse(plaintext);
        if (!Number.isFinite(record.expiresAt)) throw new Error("Invalid session expiration.");
        if (record.expiresAt <= Date.now()) {
          return this.destroy(sessionId, destroyError =>
            callback(destroyError || null, null)
          );
        }
      } catch (error) {
        return callback(error, null);
      }
      callback(null, session);
    });
  }

  set(sessionId, session, callback) {
    let contents;
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(session), "utf8"),
        cipher.final()
      ]);
      const cookieExpiry = session.cookie && session.cookie.expires
        ? new Date(session.cookie.expires).getTime()
        : Date.now() + this.ttlMs;
      if (!Number.isFinite(cookieExpiry)) throw new Error("Invalid session expiration.");
      contents = JSON.stringify({
        expiresAt: cookieExpiry,
        iv: iv.toString("base64"),
        data: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64")
      });
    } catch (error) {
      return callback(error);
    }

    const filePath = this.getSessionPath(sessionId);
    const temporaryPath = `${filePath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    fs.writeFile(temporaryPath, contents, { mode: 0o600 }, writeError => {
      if (writeError) return callback(writeError);
      fs.rename(temporaryPath, filePath, renameError => {
        if (!renameError) return callback(null);
        fs.unlink(temporaryPath, () => callback(renameError));
      });
    });
  }

  touch(sessionId, session, callback) {
    this.set(sessionId, session, callback);
  }

  destroy(sessionId, callback) {
    fs.unlink(this.getSessionPath(sessionId), error => {
      callback(error && error.code !== "ENOENT" ? error : null);
    });
  }
}

module.exports = FileSessionStore;
