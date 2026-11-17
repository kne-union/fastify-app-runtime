/**
 * 简易滑动窗口限流（单进程内存）。
 * 默认：同一 key 每 windowMs 内最多 max 次。
 */
const createRateLimiter = ({ windowMs = 60 * 1000, max = 60 } = {}) => {
  const buckets = new Map();

  const prune = (bucket, now) => {
    const cutoff = now - windowMs;
    while (bucket.length && bucket[0] < cutoff) {
      bucket.shift();
    }
  };

  const check = key => {
    const id = String(key || 'anonymous');
    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = [];
      buckets.set(id, bucket);
    }
    prune(bucket, now);
    if (bucket.length >= max) {
      const err = new Error('请求过于频繁，请稍后再试');
      err.statusCode = 429;
      throw err;
    }
    bucket.push(now);
  };

  return { check, windowMs, max };
};

const clientKeyFromRequest = (request, payload) => {
  const clientId = payload?.client_id || payload?.clientId || request.headers['x-client-id'];
  if (clientId) {
    return `client:${clientId}`;
  }
  return `ip:${request.ip || 'unknown'}`;
};

module.exports = { createRateLimiter, clientKeyFromRequest };
