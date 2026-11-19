const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_FILE = 'app-ops-platforms.json';

/**
 * 文件里每类数据的容量上限。超过后淘汰最早的记录，避免文件无限增长。
 * - accessLogs：保留最近 N 条访问日志
 * - usedJtis：已用 jti 先清掉过期项，仍超限则淘汰最早过期的
 * - redeemFailures：先清掉未锁定且超过 redeemFailureTtlMs 未更新的计数，仍超限则优先淘汰未锁定、最久未更新的
 */
const DEFAULT_LIMITS = {
  accessLogs: 5000,
  usedJtis: 5000,
  redeemFailures: 1000,
  redeemFailureTtlMs: 24 * 60 * 60 * 1000
};

const normalizeOrigin = value =>
  String(value || '')
    .replace(/\/+$/, '')
    .toLowerCase();

/** 清理已用 jti：删除过期项，超过上限则淘汰最早过期的 */
const pruneJtis = (usedJtis, max, now = Date.now()) => {
  Object.keys(usedJtis).forEach(jti => {
    if (!(usedJtis[jti] > now)) {
      delete usedJtis[jti];
    }
  });
  const overflow = Object.keys(usedJtis).length - max;
  if (overflow > 0) {
    Object.keys(usedJtis)
      .sort((a, b) => usedJtis[a] - usedJtis[b])
      .slice(0, overflow)
      .forEach(jti => delete usedJtis[jti]);
  }
};

/** 清理兑换失败计数：删除未锁定且长期未更新的，超过上限则优先淘汰未锁定、最久未更新的 */
const pruneRedeemFailures = (redeemFailures, { max, ttlMs }, now = Date.now()) => {
  const isLocked = item => item.lockedUntil > now;
  Object.keys(redeemFailures).forEach(installId => {
    const item = redeemFailures[installId];
    if (!isLocked(item) && !((item.updatedAt || 0) > now - ttlMs)) {
      delete redeemFailures[installId];
    }
  });
  const overflow = Object.keys(redeemFailures).length - max;
  if (overflow > 0) {
    Object.keys(redeemFailures)
      .sort((a, b) => {
        const lockedDiff = Number(isLocked(redeemFailures[a])) - Number(isLocked(redeemFailures[b]));
        return lockedDiff || (redeemFailures[a].updatedAt || 0) - (redeemFailures[b].updatedAt || 0);
      })
      .slice(0, overflow)
      .forEach(installId => delete redeemFailures[installId]);
  }
};

/**
 * 简易文件存储：platforms[]、access logs、consumed jti、兑换失败计数。
 * 平台登记在宿主有数据库时改存数据库（见 createPlatformDbStore），这里的 platforms 仅作无数据库时的回退。
 */
const createFileStore = ({ rootDir, fileName = DEFAULT_FILE, limits } = {}) => {
  const dir = rootDir || path.resolve(process.cwd(), './data');
  const filePath = path.join(dir, fileName);
  const maxOf = Object.assign({}, DEFAULT_LIMITS, limits);
  let cache = null;

  const ensure = async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    if (!cache) {
      try {
        cache = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        // 旧版本文件没有上限，加载时按当前上限收敛一次
        cache.accessLogs = (cache.accessLogs || []).slice(0, maxOf.accessLogs);
        cache.usedJtis = cache.usedJtis || {};
        cache.redeemFailures = cache.redeemFailures || {};
        pruneJtis(cache.usedJtis, maxOf.usedJtis);
        pruneRedeemFailures(cache.redeemFailures, { max: maxOf.redeemFailures, ttlMs: maxOf.redeemFailureTtlMs });
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
      if (data.accessLogs.length > maxOf.accessLogs) {
        data.accessLogs.length = maxOf.accessLogs;
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
      pruneJtis(data.usedJtis, maxOf.usedJtis);
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
      cur.updatedAt = Date.now();
      data.redeemFailures[installId] = cur;
      pruneRedeemFailures(data.redeemFailures, { max: maxOf.redeemFailures, ttlMs: maxOf.redeemFailureTtlMs });
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

/**
 * 平台登记的数据库存储：行内容原样存进 data（JSON 列），与文件存储的行结构一致，调用方无需改动。
 * originKey 为规范化后的主平台地址，用于唯一约束与查找。
 * 数据库跨版本部署保留，不会随版本目录被清理。
 */
const createPlatformDbStore = ({ model }) => {
  const toRow = record => (record ? record.data : null);

  return {
    async count() {
      return model.count();
    },
    async getPlatforms() {
      const records = await model.findAll({ order: [['createdAt', 'ASC']] });
      return records.map(toRow);
    },
    async upsertPlatform(row) {
      const originKey = normalizeOrigin(row.platformOrigin);
      const existing = await model.findOne({ where: { originKey } });
      const data = Object.assign({}, toRow(existing), row);
      if (existing) {
        await existing.update({ installId: data.installId || null, data });
      } else {
        await model.create({ originKey, installId: data.installId || null, data });
      }
      return data;
    },
    async removePlatform(platformOrigin) {
      const removed = await model.destroy({ where: { originKey: normalizeOrigin(platformOrigin) } });
      return removed > 0;
    },
    async findPlatformByOrigin(platformOrigin) {
      return toRow(await model.findOne({ where: { originKey: normalizeOrigin(platformOrigin) } }));
    },
    async findPlatformByInstallId(installId) {
      if (!installId) {
        return null;
      }
      return toRow(await model.findOne({ where: { installId } }));
    }
  };
};

module.exports = { createFileStore, createPlatformDbStore, DEFAULT_FILE, DEFAULT_LIMITS };
