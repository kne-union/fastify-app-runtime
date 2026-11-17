const { QueryTypes } = require('sequelize');

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|COPY|INTO|OUTFILE|EXECUTE|CALL)\b/i;
const ALLOWED_START = /^(WITH|SELECT|EXPLAIN|SHOW|DESCRIBE|DESC|PRAGMA)\b/i;

const getSequelize = fastify => fastify.sequelize?.instance || null;

const tableNameOf = model => {
  const t = typeof model.getTableName === 'function' ? model.getTableName() : model.tableName;
  if (typeof t === 'string') {
    return t;
  }
  if (t && t.tableName) {
    return t.tableName;
  }
  return String(t);
};

const buildAllowlist = (fastify, options, config = {}) => {
  const sequelize = getSequelize(fastify);
  if (!sequelize) {
    return new Set();
  }
  const fromEnv = String(config.APP_OPS_DB_TABLES || process.env.APP_OPS_DB_TABLES || options.appOps?.dbTables || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (fromEnv.length) {
    return new Set(fromEnv);
  }
  const set = new Set();
  for (const model of Object.values(sequelize.models || {})) {
    set.add(tableNameOf(model));
  }
  set.delete('SequelizeMeta');
  const prefix = config.DB_TABLE_PREFIX || process.env.DB_TABLE_PREFIX || '';
  if (prefix) {
    for (const name of [...set]) {
      if (!name.startsWith(prefix)) {
        set.delete(name);
      }
    }
  }
  return set;
};

const assertTableAllowed = (table, allowlist) => {
  if (!allowlist.has(table)) {
    const err = new Error(`表不在白名单：${table}`);
    err.statusCode = 403;
    throw err;
  }
};

const quoteId = name => `"${String(name).replace(/"/g, '""')}"`;

const listTables = async (fastify, options) => {
  const sequelize = getSequelize(fastify);
  if (!sequelize) {
    const err = new Error('未启用数据库');
    err.statusCode = 400;
    throw err;
  }
  const allowlist = buildAllowlist(fastify, options, fastify.config || {});
  const qi = sequelize.getQueryInterface();
  const all = (await qi.describeTable) ? null : null;
  const pageData = [];
  for (const table of [...allowlist].sort()) {
    let columns = [];
    try {
      const desc = await qi.describeTable(table);
      columns = Object.entries(desc).map(([name, meta]) => ({
        name,
        type: meta.type,
        primaryKey: !!meta.primaryKey,
        allowNull: meta.allowNull !== false
      }));
    } catch (e) {
      columns = [];
    }
    // 字段名与 app-manager describeTableSafe / DataOps 对齐：用 table 而非 name
    pageData.push({
      table,
      columns,
      primaryKey: columns.filter(c => c.primaryKey).map(c => c.name)
    });
  }
  const config = fastify.config || {};
  return {
    pageData,
    totalCount: pageData.length,
    // 供主平台 DataOps 区分：远程进程自有库，宿主不可改连接
    dbScope: 'remote',
    readOnly: true,
    softDeleteField: 'deleted_at',
    connection: {
      dialect: config.DB_DIALECT || sequelize.getDialect?.() || null,
      host: config.DB_HOST || null,
      port: config.DB_PORT || null,
      database: config.DB_DATABASE || config.DB_STORAGE || null,
      hasCustomDb: false
    }
  };
};

const listRows = async (fastify, options, { table, filter, keyword, sort, perPage = 20, currentPage = 1 } = {}) => {
  const sequelize = getSequelize(fastify);
  const allowlist = buildAllowlist(fastify, options, fastify.config || {});
  assertTableAllowed(table, allowlist);
  const limit = Math.min(100, Math.max(1, Number(perPage) || 20));
  const page = Math.max(1, Number(currentPage) || 1);
  const offset = (page - 1) * limit;
  const qTable = quoteId(table);
  const whereParts = [];
  const replacements = {};
  let parsedFilter = filter;
  if (typeof filter === 'string') {
    try {
      parsedFilter = JSON.parse(filter);
    } catch (e) {
      parsedFilter = {};
    }
  }
  if (parsedFilter && typeof parsedFilter === 'object') {
    let i = 0;
    for (const [key, value] of Object.entries(parsedFilter)) {
      if (!/^[A-Za-z0-9_]+$/.test(key)) {
        continue;
      }
      const p = `f${i++}`;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // 简化：仅等值
        continue;
      }
      whereParts.push(`${quoteId(key)} = :${p}`);
      replacements[p] = value;
    }
  }
  if (keyword) {
    // 关键字仅作简单说明：无列元数据时跳过模糊；有列则 OR LIKE 字符串列在上层可扩展
  }
  const whereSql = whereParts.length ? ` WHERE ${whereParts.join(' AND ')}` : '';
  let orderSql = '';
  let parsedSort = sort;
  if (typeof sort === 'string') {
    try {
      parsedSort = JSON.parse(sort);
    } catch (e) {
      parsedSort = null;
    }
  }
  if (Array.isArray(parsedSort) && parsedSort.length) {
    const bits = parsedSort.filter(s => s && /^[A-Za-z0-9_]+$/.test(s.name)).map(s => `${quoteId(s.name)} ${String(s.sort).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`);
    if (bits.length) {
      orderSql = ` ORDER BY ${bits.join(', ')}`;
    }
  }
  const countRows = await sequelize.query(`SELECT COUNT(*) AS cnt FROM ${qTable}${whereSql}`, {
    replacements,
    type: QueryTypes.SELECT
  });
  const totalCount = Number(countRows[0]?.cnt || countRows[0]?.CNT || 0);
  const pageData = await sequelize.query(`SELECT * FROM ${qTable}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`, {
    replacements,
    type: QueryTypes.SELECT
  });
  return { pageData, totalCount };
};

const runQuery = async (fastify, options, { sql, replacements = {}, maxRows } = {}) => {
  const sequelize = getSequelize(fastify);
  if (!sequelize) {
    const err = new Error('未启用数据库');
    err.statusCode = 400;
    throw err;
  }
  const text = String(sql || '').trim();
  if (!text || text.includes(';')) {
    const err = new Error('仅允许单条只读 SQL');
    err.statusCode = 400;
    throw err;
  }
  if (!ALLOWED_START.test(text) || FORBIDDEN_SQL.test(text)) {
    const err = new Error('SQL 不允许或包含写操作关键字');
    err.statusCode = 400;
    throw err;
  }
  const allowlist = buildAllowlist(fastify, options, fastify.config || {});
  // 粗检：引用的标识符若像表名则须在白名单（简化，不强制解析器）
  const limit = Math.min(500, Math.max(1, Number(maxRows) || Number(process.env.APP_OPS_DB_MAX_ROWS || 200)));
  const timeout = Number(process.env.APP_OPS_DB_QUERY_TIMEOUT_MS || 10000);
  const rows = await Promise.race([sequelize.query(text, { replacements, type: QueryTypes.SELECT }), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('查询超时'), { statusCode: 504 })), timeout))]);
  const pageData = Array.isArray(rows) ? rows.slice(0, limit) : [];
  // 表白名单：若 SQL 很短且 FROM 后能抠出表名则校验
  const fromMatch = text.match(/\bFROM\s+"?([A-Za-z0-9_]+)"?/i);
  if (fromMatch && allowlist.size && !allowlist.has(fromMatch[1])) {
    const err = new Error(`表不在白名单：${fromMatch[1]}`);
    err.statusCode = 403;
    throw err;
  }
  return { pageData, totalCount: pageData.length };
};

const saveRow = async (fastify, options, { table, data = {}, autoGenerate = {} } = {}) => {
  const sequelize = getSequelize(fastify);
  const allowlist = buildAllowlist(fastify, options, fastify.config || {});
  assertTableAllowed(table, allowlist);
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable(table);
  const payload = {};
  for (const [key, value] of Object.entries(data)) {
    if (desc[key]) {
      payload[key] = value;
    }
  }
  for (const [key, enabled] of Object.entries(autoGenerate || {})) {
    if (enabled && (payload[key] == null || payload[key] === '') && desc[key] && typeof sequelize.generateId === 'function') {
      payload[key] = sequelize.generateId();
    }
  }
  const pkCols = Object.entries(desc)
    .filter(([, m]) => m.primaryKey)
    .map(([n]) => n);
  if (!pkCols.length) {
    const err = new Error('表无主键，无法保存');
    err.statusCode = 400;
    throw err;
  }
  const where = {};
  let hasPk = true;
  for (const col of pkCols) {
    if (payload[col] == null) {
      hasPk = false;
      break;
    }
    where[col] = payload[col];
  }
  if (hasPk) {
    const whereSql = pkCols.map((c, i) => `${quoteId(c)} = :pk${i}`).join(' AND ');
    const replacements = Object.fromEntries(pkCols.map((c, i) => [`pk${i}`, where[c]]));
    const existing = await sequelize.query(`SELECT 1 AS ok FROM ${quoteId(table)} WHERE ${whereSql} LIMIT 1`, {
      replacements,
      type: QueryTypes.SELECT
    });
    if (existing.length) {
      const sets = Object.keys(payload)
        .filter(k => !pkCols.includes(k))
        .map((k, i) => `${quoteId(k)} = :s${i}`);
      const setRepl = Object.fromEntries(
        Object.keys(payload)
          .filter(k => !pkCols.includes(k))
          .map((k, i) => [`s${i}`, payload[k]])
      );
      if (sets.length) {
        await sequelize.query(`UPDATE ${quoteId(table)} SET ${sets.join(', ')} WHERE ${whereSql}`, {
          replacements: Object.assign({}, setRepl, replacements)
        });
      }
      const rows = await sequelize.query(`SELECT * FROM ${quoteId(table)} WHERE ${whereSql} LIMIT 1`, {
        replacements,
        type: QueryTypes.SELECT
      });
      return rows[0] || null;
    }
  }
  const cols = Object.keys(payload);
  const values = cols.map((_, i) => `:v${i}`);
  const replacements = Object.fromEntries(cols.map((k, i) => [`v${i}`, payload[k]]));
  await sequelize.query(`INSERT INTO ${quoteId(table)} (${cols.map(quoteId).join(',')}) VALUES (${values.join(',')})`, { replacements });
  if (hasPk) {
    const whereSql = pkCols.map((c, i) => `${quoteId(c)} = :pk${i}`).join(' AND ');
    const replacementsPk = Object.fromEntries(pkCols.map((c, i) => [`pk${i}`, where[c]]));
    const rows = await sequelize.query(`SELECT * FROM ${quoteId(table)} WHERE ${whereSql} LIMIT 1`, {
      replacements: replacementsPk,
      type: QueryTypes.SELECT
    });
    return rows[0] || payload;
  }
  return payload;
};

const removeRow = async (fastify, options, { table, id, pk } = {}) => {
  const sequelize = getSequelize(fastify);
  const allowlist = buildAllowlist(fastify, options, fastify.config || {});
  assertTableAllowed(table, allowlist);
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable(table);
  const pkCols = Object.entries(desc)
    .filter(([, m]) => m.primaryKey)
    .map(([n]) => n);
  const key = pk || (id != null ? { [pkCols[0]]: id } : null);
  if (!key) {
    const err = new Error('缺少主键');
    err.statusCode = 400;
    throw err;
  }
  const whereSql = Object.keys(key)
    .map((c, i) => `${quoteId(c)} = :pk${i}`)
    .join(' AND ');
  const replacements = Object.fromEntries(Object.keys(key).map((c, i) => [`pk${i}`, key[c]]));
  if (desc.deleted_at || desc.deletedAt) {
    const col = desc.deleted_at ? 'deleted_at' : 'deletedAt';
    await sequelize.query(`UPDATE ${quoteId(table)} SET ${quoteId(col)} = CURRENT_TIMESTAMP WHERE ${whereSql}`, { replacements });
  } else {
    await sequelize.query(`DELETE FROM ${quoteId(table)} WHERE ${whereSql}`, { replacements });
  }
  return { ok: true };
};

module.exports = {
  listTables,
  listRows,
  runQuery,
  saveRow,
  removeRow,
  buildAllowlist,
  getSequelize
};
