const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');

const ensureDir = async dir => fs.promises.mkdir(dir, { recursive: true });

const resolveLogPaths = (options, config = {}) => {
  const cwd = options.appOps?.cwd || process.cwd();
  const logsDir = path.resolve(cwd, options.appOps?.logsDir || './logs');
  const outPath = config.APP_OPS_LOG_OUT || process.env.APP_OPS_LOG_OUT || path.join(logsDir, 'out.log');
  const errPath = config.APP_OPS_LOG_ERR || process.env.APP_OPS_LOG_ERR || path.join(logsDir, 'err.log');
  return { logsDir, outPath: path.resolve(outPath), errPath: path.resolve(errPath) };
};

const isLogDisabled = (options, config = {}) => {
  const v = options.appOps?.logDisabled ?? config.APP_OPS_LOG_DISABLED ?? process.env.APP_OPS_LOG_DISABLED;
  return v === true || v === '1' || String(v).toLowerCase() === 'true';
};

const shouldTee = (options, config = {}) => {
  if (isLogDisabled(options, config)) {
    return false;
  }
  const v = options.appOps?.logTee ?? config.APP_OPS_LOG_TEE ?? process.env.APP_OPS_LOG_TEE;
  if (v === false || v === '0' || String(v).toLowerCase() === 'false') {
    return false;
  }
  return true;
};

const formatLine = (message, timeZone) => {
  const d = new Date();
  let stamp;
  try {
    stamp = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timeZone || process.env.APP_OPS_LOG_TIMEZONE || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
      .format(d)
      .replace(' ', 'T');
  } catch (e) {
    stamp = d.toISOString().slice(0, 19);
  }
  const text = typeof message === 'string' ? message : String(message);
  return `${stamp}: ${text.replace(/\n+$/, '')}\n`;
};

const installTee = ({ outPath, errPath, timeZone }) => {
  const append = (file, chunk) => {
    fs.appendFile(file, chunk, () => {});
  };
  const wrapConsole = (method, file) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        append(file, formatLine(args.map(a => (typeof a === 'string' ? a : require('node:util').inspect(a))).join(' '), timeZone));
      } catch (e) {
        /* ignore */
      }
    };
  };
  wrapConsole('log', outPath);
  wrapConsole('info', outPath);
  wrapConsole('debug', outPath);
  wrapConsole('warn', outPath);
  wrapConsole('error', errPath);

  const teeStream = (stream, file) => {
    const originalWrite = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => {
      try {
        const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk);
        append(file, formatLine(text, timeZone));
      } catch (e) {
        /* ignore */
      }
      return originalWrite(chunk, encoding, cb);
    };
  };
  teeStream(process.stdout, outPath);
  teeStream(process.stderr, errPath);
};

const readLinesReverse = async (filePath, { perPage = 100, beforeLine = null } = {}) => {
  if (!fs.existsSync(filePath)) {
    return { pageData: [], totalCount: 0, hasMore: false };
  }
  const isGz = filePath.endsWith('.gz');
  const lines = [];
  const input = isGz ? createReadStream(filePath).pipe(createGunzip()) : createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    lines.push(line);
  }
  const totalCount = lines.length;
  let end = totalCount;
  if (beforeLine != null && Number.isFinite(Number(beforeLine))) {
    end = Math.min(totalCount, Math.max(0, Number(beforeLine) - 1));
  }
  const start = Math.max(0, end - perPage);
  const pageData = lines.slice(start, end).map((content, i) => ({ line: start + i + 1, content }));
  return { pageData, totalCount, hasMore: start > 0 };
};

const listLogFiles = async ({ outPath, errPath, logsDir }) => {
  await ensureDir(logsDir);
  const pageData = [];
  for (const [stream, filePath] of [
    ['out', outPath],
    ['err', errPath]
  ]) {
    try {
      const st = await fs.promises.stat(filePath);
      pageData.push({
        fileName: path.basename(filePath),
        stream,
        size: st.size,
        compressed: false,
        current: true,
        mtime: st.mtime.toISOString()
      });
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
  let entries = [];
  try {
    entries = await fs.promises.readdir(logsDir);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  for (const name of entries) {
    if (!/^(out|err)-\d{8}-\d{6}\.log(\.gz)?$/.test(name)) {
      continue;
    }
    const full = path.join(logsDir, name);
    const st = await fs.promises.stat(full);
    pageData.push({
      fileName: name,
      stream: name.startsWith('err') ? 'err' : 'out',
      size: st.size,
      compressed: name.endsWith('.gz'),
      current: false,
      mtime: st.mtime.toISOString()
    });
  }
  pageData.sort((a, b) => {
    if (a.current !== b.current) {
      return a.current ? -1 : 1;
    }
    return String(b.mtime).localeCompare(String(a.mtime));
  });
  return { pageData, totalCount: pageData.length };
};

const resolveReadableFile = ({ file, stream, outPath, errPath, logsDir }) => {
  if (file) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes('..')) {
      const err = new Error('非法日志文件名');
      err.statusCode = 400;
      throw err;
    }
    const full = path.join(logsDir, file);
    if (!full.startsWith(logsDir)) {
      const err = new Error('非法日志路径');
      err.statusCode = 400;
      throw err;
    }
    return full;
  }
  return stream === 'err' ? errPath : outPath;
};

const createLogsRuntime = (fastify, options) => {
  const config = fastify.config || {};
  const paths = resolveLogPaths(options, config);
  let rotateTimer = null;

  const start = async () => {
    if (isLogDisabled(options, config)) {
      return { enabled: false, ...paths };
    }
    await ensureDir(paths.logsDir);
    if (shouldTee(options, config)) {
      installTee({
        outPath: paths.outPath,
        errPath: paths.errPath,
        timeZone: process.env.APP_OPS_LOG_TIMEZONE || 'Asia/Shanghai'
      });
    }
    const intervalMs = Number(process.env.APP_OPS_LOG_ROTATE_INTERVAL_MS || 60000);
    rotateTimer = setInterval(() => {
      rotateIfNeeded(paths).catch(err => fastify.log.warn({ err }, 'app-ops: log rotate failed'));
    }, intervalMs);
    if (rotateTimer.unref) {
      rotateTimer.unref();
    }
    return { enabled: true, ...paths };
  };

  const stop = () => {
    if (rotateTimer) {
      clearInterval(rotateTimer);
      rotateTimer = null;
    }
  };

  return {
    paths,
    start,
    stop,
    isEnabled: () => !isLogDisabled(options, config),
    read: async query => {
      if (isLogDisabled(options, config)) {
        const err = new Error('日志未启用');
        err.statusCode = 400;
        throw err;
      }
      const perPage = Math.min(100, Math.max(1, Number(query.perPage) || 100));
      const filePath = resolveReadableFile({
        file: query.file,
        stream: query.stream || 'out',
        ...paths
      });
      return readLinesReverse(filePath, {
        perPage,
        beforeLine: query.beforeLine != null ? Number(query.beforeLine) : null
      });
    },
    files: async () => {
      if (isLogDisabled(options, config)) {
        const err = new Error('日志未启用');
        err.statusCode = 400;
        throw err;
      }
      return listLogFiles(paths);
    },
    /**
     * SSE：先回放最近 replay 行，再轮询当前日志文件推送新行。
     * 调用方负责鉴权；本方法会 hijack reply。
     */
    stream: async (request, reply, query = {}) => {
      if (isLogDisabled(options, config)) {
        const err = new Error('日志未启用');
        err.statusCode = 400;
        throw err;
      }
      const streamName = query.stream === 'err' ? 'err' : 'out';
      const filePath = streamName === 'err' ? paths.errPath : paths.outPath;
      const replay = Math.min(500, Math.max(1, Number(query.replay || config.APP_OPS_LOG_SSE_REPLAY || process.env.APP_OPS_LOG_SSE_REPLAY || 100)));
      const pollMs = Math.min(5000, Math.max(500, Number(query.pollMs || process.env.APP_OPS_LOG_SSE_POLL_MS || 1000)));

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const writeEvent = (event, data) => {
        if (event) {
          reply.raw.write(`event: ${event}\n`);
        }
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const heartbeat = setInterval(
        () => {
          try {
            reply.raw.write(`: ping\n\n`);
          } catch (e) {
            /* ignore */
          }
        },
        Number(options.appOps?.sseHeartbeatMs || 15000)
      );
      if (heartbeat.unref) {
        heartbeat.unref();
      }

      let closed = false;
      let pollTimer = null;
      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(heartbeat);
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        try {
          reply.raw.end();
        } catch (e) {
          /* ignore */
        }
      };
      request.raw.on('close', close);

      // 回放最近行
      try {
        const { pageData } = await readLinesReverse(filePath, { perPage: replay });
        for (const row of pageData || []) {
          writeEvent('log', {
            stream: streamName,
            content: row.content,
            line: row.line,
            loggedAt: new Date().toISOString()
          });
        }
      } catch (e) {
        writeEvent('error', { message: e.message || 'replay failed' });
      }

      let offset = 0;
      try {
        offset = (await fs.promises.stat(filePath)).size;
      } catch (e) {
        offset = 0;
      }

      pollTimer = setInterval(async () => {
        if (closed) {
          return;
        }
        try {
          const st = await fs.promises.stat(filePath);
          if (st.size < offset) {
            // 文件被 rotate，从头读
            offset = 0;
          }
          if (st.size <= offset) {
            return;
          }
          const chunk = await new Promise((resolve, reject) => {
            const bufs = [];
            const rs = createReadStream(filePath, { start: offset, end: st.size - 1 });
            rs.on('data', d => bufs.push(d));
            rs.on('error', reject);
            rs.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
          });
          offset = st.size;
          const parts = chunk.split('\n');
          // 末尾空段丢弃（文件常以 \n 结尾）
          if (parts.length && parts[parts.length - 1] === '') {
            parts.pop();
          }
          for (const content of parts) {
            if (!content) {
              continue;
            }
            writeEvent('log', {
              stream: streamName,
              content,
              loggedAt: new Date().toISOString()
            });
          }
        } catch (e) {
          if (!closed) {
            writeEvent('error', { message: e.message || 'poll failed' });
          }
        }
      }, pollMs);
      if (pollTimer.unref) {
        pollTimer.unref();
      }
    }
  };
};

const rotateIfNeeded = async ({ outPath, errPath, logsDir }) => {
  const maxSize = Number(process.env.APP_OPS_LOG_MAX_SIZE || 50 * 1024 * 1024);
  const rotateDaily = String(process.env.APP_OPS_LOG_ROTATE_DAILY || 'true').toLowerCase() !== 'false';
  const retentionFiles = Number(process.env.APP_OPS_LOG_RETENTION_FILES || 20);
  const retentionDays = Number(process.env.APP_OPS_LOG_RETENTION_DAYS || 14);
  const statePath = path.join(logsDir, '.rotate-state.json');
  let state = {};
  try {
    state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
  } catch (e) {
    /* empty */
  }
  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 15);

  for (const [stream, filePath] of [
    ['out', outPath],
    ['err', errPath]
  ]) {
    let st;
    try {
      st = await fs.promises.stat(filePath);
    } catch (e) {
      continue;
    }
    if (!st.size) {
      continue;
    }
    const started = state[stream] ? new Date(state[stream]) : st.birthtime || st.mtime;
    const crossDay = rotateDaily && started.toDateString() !== now.toDateString();
    if (st.size < maxSize && !crossDay) {
      continue;
    }
    const archive = path.join(logsDir, `${stream}-${stamp}.log`);
    await fs.promises.rename(filePath, archive);
    await fs.promises.writeFile(filePath, '', 'utf8');
    state[stream] = now.toISOString();
    await pipeline(createReadStream(archive), zlib.createGzip(), fs.createWriteStream(`${archive}.gz`));
    await fs.promises.unlink(archive).catch(() => {});
  }
  await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');

  const entries = await fs.promises.readdir(logsDir);
  const archives = [];
  for (const name of entries) {
    if (!/^(out|err)-\d{8}-\d{6}\.log\.gz$/.test(name)) {
      continue;
    }
    const full = path.join(logsDir, name);
    const st = await fs.promises.stat(full);
    archives.push({ name, full, mtime: st.mtimeMs, stream: name.startsWith('err') ? 'err' : 'out' });
  }
  const cutoff = Date.now() - retentionDays * 86400000;
  for (const stream of ['out', 'err']) {
    const list = archives.filter(a => a.stream === stream).sort((a, b) => b.mtime - a.mtime);
    list.forEach((item, index) => {
      if (index >= retentionFiles || item.mtime < cutoff) {
        fs.promises.unlink(item.full).catch(() => {});
      }
    });
  }
};

module.exports = { createLogsRuntime, resolveLogPaths, isLogDisabled };
