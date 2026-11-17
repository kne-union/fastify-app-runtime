/**
 * 供主平台启动同步拉取的权限树。
 * 默认从 options.appOps.getPermissions 或 fastify[tenant].permissions / account 取；无则空数组。
 */
const getPermissions = async (fastify, options) => {
  if (typeof options.appOps?.getPermissions === 'function') {
    return options.appOps.getPermissions({ fastify }) || [];
  }
  const tenantNs = options.appOps?.tenantNamespace || 'tenant';
  const tenant = fastify[tenantNs];
  if (tenant?.permissions) {
    return Array.isArray(tenant.permissions) ? tenant.permissions : tenant.permissions;
  }
  if (typeof tenant?.services?.permission?.list === 'function') {
    try {
      return await tenant.services.permission.list({});
    } catch (e) {
      return [];
    }
  }
  return [];
};

module.exports = { getPermissions };
