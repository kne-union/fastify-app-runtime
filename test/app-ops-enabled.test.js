const { expect } = require('chai');
const { isAppOpsEnabled, parseTruthy } = require('../libs/app-ops/enabled');

describe('APP_OPS_ENABLED 总开关', () => {
  it('parseTruthy 识别常见真值', () => {
    expect(parseTruthy('true')).to.equal(true);
    expect(parseTruthy('1')).to.equal(true);
    expect(parseTruthy('YES')).to.equal(true);
    expect(parseTruthy('on')).to.equal(true);
    expect(parseTruthy('false')).to.equal(false);
    expect(parseTruthy('')).to.equal(false);
    expect(parseTruthy(undefined)).to.equal(false);
  });

  it('options.appOps.enabled 优先于 env', () => {
    expect(isAppOpsEnabled({ appOps: { enabled: true } }, { APP_OPS_ENABLED: false })).to.equal(true);
    expect(isAppOpsEnabled({ appOps: { enabled: false } }, { APP_OPS_ENABLED: true })).to.equal(false);
  });

  it('未配置时默认关闭', () => {
    const prev = process.env.APP_OPS_ENABLED;
    delete process.env.APP_OPS_ENABLED;
    try {
      expect(isAppOpsEnabled({}, {})).to.equal(false);
    } finally {
      if (prev !== undefined) {
        process.env.APP_OPS_ENABLED = prev;
      }
    }
  });

  it('可读 process.env.APP_OPS_ENABLED', () => {
    const prev = process.env.APP_OPS_ENABLED;
    process.env.APP_OPS_ENABLED = 'true';
    try {
      expect(isAppOpsEnabled({}, {})).to.equal(true);
    } finally {
      if (prev === undefined) {
        delete process.env.APP_OPS_ENABLED;
      } else {
        process.env.APP_OPS_ENABLED = prev;
      }
    }
  });
});
