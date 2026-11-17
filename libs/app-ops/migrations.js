const fs = require('node:fs');
const path = require('node:path');
const { QueryTypes } = require('sequelize');

const SQL_NAME_RE = /^[A-Za-z0-9_.-]+\.sql$/;

/**
 * 解析 SQL 目录：进程 cwd 可能是仓库根或 server/。
 * - 显式 APP_OPS_SQL_PATH / appOps.sqlPath 优先
 * - 否则依次尝试 cwd/sql（cwd=server）与 cwd/server/sql（cwd=仓库根）
 */
const resolveSqlDir = (options, config = {}) => {
  const configured = config.APP_OPS_SQL_PATH || process.env.APP_OPS_SQL_PATH || options.appOps?.sqlPath;
  const candidates = [];
  if (configured) {
    candidates.push(path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured));
  }
  candidates.push(path.resolve(process.cwd(), 'sql'));
  candidates.push(path.resolve(process.cwd(), 'server/sql'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch (e) {
      // try next
    }
  }
  return candidates[0] || path.resolve(process.cwd(), 'sql');
};

const assertSafeFile = file => {
  if (!SQL_NAME_RE.test(file)) {
    const err = new Error('非法 SQL 文件名');
    err.statusCode = 400;
    throw err;
  }
};

const getMigrationTable = () => process.env.APP_OPS_MIGRATION_TABLE || '_fs_sql_migrations';

const ensureMigrationTable = async sequelize => {
  const table = getMigrationTable();
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS "${table.replace(/"/g, '')}" (
      "name" VARCHAR(255) PRIMARY KEY,
      "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
};

const listMigrations = async (fastify, options) => {
  const dir = resolveSqlDir(options, fastify.config || {});
  let files = [];
  try {
    files = (await fs.promises.readdir(dir)).filter(f => SQL_NAME_RE.test(f)).sort();
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { pageData: [], totalCount: 0, dbError: null };
    }
    throw e;
  }
  const sequelize = fastify.sequelize?.instance;
  let executedMap = new Map();
  let dbError = null;
  if (sequelize) {
    try {
      await ensureMigrationTable(sequelize);
      const rows = await sequelize.query(`SELECT name, executed_at FROM "${getMigrationTable()}"`, { type: QueryTypes.SELECT });
      executedMap = new Map(rows.map(r => [r.name, r.executed_at || r.executedAt]));
    } catch (e) {
      dbError = e.message;
    }
  }
  const pageData = [];
  for (const name of files) {
    const st = await fs.promises.stat(path.join(dir, name));
    const executedAt = executedMap.get(name) || null;
    pageData.push({
      name,
      size: st.size,
      updatedAt: st.mtime.toISOString(),
      executed: dbError ? null : executedMap.has(name),
      executedAt: executedAt ? new Date(executedAt).toISOString() : null
    });
  }
  return { pageData, totalCount: pageData.length, dbError };
};

const readMigrationContent = async (fastify, options, file) => {
  assertSafeFile(file);
  const dir = resolveSqlDir(options, fastify.config || {});
  const full = path.join(dir, file);
  if (!full.startsWith(dir)) {
    const err = new Error('非法路径');
    err.statusCode = 400;
    throw err;
  }
  const content = await fs.promises.readFile(full, 'utf8');
  return { name: file, content };
};

const runAction = async (fastify, options, { file, action }) => {
  assertSafeFile(file);
  const sequelize = fastify.sequelize?.instance;
  if (!sequelize) {
    const err = new Error('未启用数据库');
    err.statusCode = 400;
    throw err;
  }
  await ensureMigrationTable(sequelize);
  const table = getMigrationTable();
  if (action === 'unmark') {
    await sequelize.query(`DELETE FROM "${table}" WHERE name = :name`, { replacements: { name: file } });
    return { ok: true, action, file };
  }
  if (action === 'mark') {
    await sequelize
      .query(`INSERT INTO "${table}" (name, executed_at) VALUES (:name, CURRENT_TIMESTAMP) ON CONFLICT (name) DO NOTHING`, {
        replacements: { name: file }
      })
      .catch(async () => {
        // sqlite / mysql 兼容：先查再插
        const rows = await sequelize.query(`SELECT 1 AS ok FROM "${table}" WHERE name = :name`, {
          replacements: { name: file },
          type: QueryTypes.SELECT
        });
        if (!rows.length) {
          await sequelize.query(`INSERT INTO "${table}" (name) VALUES (:name)`, { replacements: { name: file } });
        }
      });
    return { ok: true, action, file };
  }
  if (action === 'execute') {
    const { content } = await readMigrationContent(fastify, options, file);
    await sequelize.query(content);
    await runAction(fastify, options, { file, action: 'mark' });
    return { ok: true, action, file };
  }
  const err = new Error(`未知 action：${action}`);
  err.statusCode = 400;
  throw err;
};

module.exports = { listMigrations, readMigrationContent, runAction, resolveSqlDir };
