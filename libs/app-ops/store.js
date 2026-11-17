const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = 'app-ops-platforms.json';

/**
 * 简易文件存储：platforms[]、access logs、consumed jti。
 * 生产可换 DB；一期保证可运行且不依赖新 model。
 */
const createFileStore = ({ rootDir, fileName = DEFAULT_FILE } = {}) => {
  const dir = rootDir || path.resolve(process.cwd(), './data');
  const filePath = path.join(dir, fileName);
  let cache = null;

  const ensure = async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    if (!cache) {
      try {
        cache = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
        cache = { platforms: [], accessLogs: [], usedJtis: {}, redeemFailures: {} };
      }
    }
    return cache;
  };

  const persist = async () => {
    await ensure();
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.promises.rename(tmp, filePath);
  };

  const hashSecret = secret => crypto.createHash('sha256').update(String(secret)).digest('hex');

  return {
    filePath,
    hashSecret,
    async getPlatforms() {
      const data = await ensure();
      return data.platforms.slice();
    },
    async upsertPlatform(row) {
      const data = await ensure();
      const key = String(row.platformOrigin || '')
        .replace(/\/+$/, '')
        .toLowerCase();
      const idx = data.platforms.findIndex(p => p.platformOrigin.toLowerCase() === key);
      if (idx >= 0) {
        data.platforms[idx] = Object.assign({}, data.platforms[idx], row);
      } else {
        data.platforms.push(row);
      }
      await persist();
      return data.platforms.find(p => p.platformOrigin.toLowerCase() === key);
    },
    async removePlatform(platformOrigin) {
      const data = await ensure();
      const key = String(platformOrigin || '')
        .replace(/\/+$/, '')
        .toLowerCase();
      const before = data.platforms.length;
      data.platforms = data.platforms.filter(p => p.platformOrigin.toLowerCase() !== key);
      await persist();
      return data.platforms.length !== before;
    },
    async findPlatformByOrigin(platformOrigin) {
      const data = await ensure();
      const key = String(platformOrigin || '')
        .replace(/\/+$/, '')
        .toLowerCase();
      return data.platforms.find(p => p.platformOrigin.toLowerCase() === key) || null;
    },
    async findPlatformByInstallId(installId) {
      const data = await ensure();
      return data.platforms.find(p => p.installId === installId) || null;
    },
    async appendAccessLog(entry) {
      const data = await ensure();
      data.accessLogs.unshift(
        Object.assign(
          {
            id: crypto.randomUUID(),
            at: new Date().toISOString()
          },
          entry
        )
      );
      const max = 5000;
      if (data.accessLogs.length > max) {
        data.accessLogs.length = max;
      }
      await persist();
    },
    async listAccessLogs({ platformOrigin, action, limit = 50, offset = 0 } = {}) {
      const data = await ensure();
      let rows = data.accessLogs;
      if (platformOrigin) {
        const key = String(platformOrigin).replace(/\/+$/, '').toLowerCase();
        rows = rows.filter(r => String(r.platformOrigin || '').toLowerCase() === key);
      }
      if (action) {
        rows = rows.filter(r => r.action === action);
      }
      return { pageData: rows.slice(offset, offset + limit), totalCount: rows.length };
    },
    async hasJti(jti) {
      const data = await ensure();
      const exp = data.usedJtis[jti];
      if (!exp) {
        return false;
      }
      if (exp <= Date.now()) {
        delete data.usedJtis[jti];
        await persist();
        return false;
      }
      return true;
    },
    async addJti(jti, ttlMs) {
      const data = await ensure();
      data.usedJtis[jti] = Date.now() + ttlMs;
      await persist();
    },
    async bumpRedeemFailure(installId) {
      const data = await ensure();
      const cur = data.redeemFailures[installId] || { count: 0, lockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= 5) {
        cur.lockedUntil = Date.now() + 15 * 60 * 1000;
        cur.count = 0;
      }
      data.redeemFailures[installId] = cur;
      await persist();
      return cur;
    },
    async clearRedeemFailure(installId) {
      const data = await ensure();
      delete data.redeemFailures[installId];
      await persist();
    },
    async getRedeemFailure(installId) {
      const data = await ensure();
      return data.redeemFailures[installId] || { count: 0, lockedUntil: 0 };
    }
  };
};

module.exports = { createFileStore, DEFAULT_FILE };
