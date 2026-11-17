/**
 * 远程管理总开关：未开启时不注册任何 /app-ops 路由（对外等价于不存在）。
 *
 * 优先级：options.appOps.enabled（布尔）> 环境变量 APP_OPS_ENABLED
 * 真值：true / 1 / yes / on（大小写不敏感）；缺省为 false。
 */
const parseTruthy = value => {
  if (value === true || value === 1) {
    return true;
  }
  if (value == null || value === false || value === 0) {
    return false;
  }
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const isAppOpsEnabled = (options = {}, config = {}) => {
  if (options.appOps && Object.prototype.hasOwnProperty.call(options.appOps, 'enabled')) {
    return parseTruthy(options.appOps.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(config, 'APP_OPS_ENABLED')) {
    return parseTruthy(config.APP_OPS_ENABLED);
  }
  return parseTruthy(process.env.APP_OPS_ENABLED);
};

module.exports = { parseTruthy, isAppOpsEnabled };
