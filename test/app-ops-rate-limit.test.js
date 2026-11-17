const { expect } = require('chai');
const { createRateLimiter } = require('../libs/app-ops/rate-limit');

describe('app-ops rate limit', () => {
  it('超过窗口次数抛 429', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    limiter.check('a');
    limiter.check('a');
    try {
      limiter.check('a');
      expect.fail('should throw');
    } catch (e) {
      expect(e.statusCode).to.equal(429);
    }
  });

  it('不同 key 互不影响', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    limiter.check('x');
    limiter.check('y');
  });
});
