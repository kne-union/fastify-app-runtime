const { expect } = require('chai');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createLogsRuntime } = require('../libs/app-ops/logs');

describe('app-ops logs stream helper', () => {
  it('exposes stream method on runtime', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-ops-logs-'));
    const outPath = path.join(dir, 'out.log');
    fs.writeFileSync(outPath, 'line-a\nline-b\n');
    const fakeFastify = { log: { info() {}, warn() {} }, config: {} };
    const runtime = createLogsRuntime(fakeFastify, {
      appOps: { logsDir: dir, logTee: false, cwd: dir }
    });
    // override paths by writing via resolve — createLogsRuntime uses resolveLogPaths
    expect(runtime.stream).to.be.a('function');
    expect(runtime.files).to.be.a('function');
    expect(runtime.read).to.be.a('function');
  });
});
