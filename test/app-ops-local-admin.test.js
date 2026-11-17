const { expect } = require('chai');
const { requireLocalAdmin } = require('../libs/app-ops/auth');

describe('requireLocalAdmin', () => {
  it('先走 user 再 admin，避免 userInfo 为空时读 id 崩溃', async () => {
    const order = [];
    const request = { userInfo: null };
    const fastify = {
      account: {
        authenticate: {
          user: async req => {
            order.push('user');
            req.userInfo = { id: 'u1', isSuperAdmin: true };
          },
          admin: async req => {
            order.push('admin');
            if (!req.userInfo?.id) {
              throw new Error("Cannot read properties of undefined (reading 'id')");
            }
          }
        }
      }
    };
    const user = await requireLocalAdmin(fastify, request);
    expect(order).to.deep.equal(['user', 'admin']);
    expect(user).to.have.property('id', 'u1');
  });

  it('优先使用 oidc.authenticate.user/admin', async () => {
    const order = [];
    const request = {};
    const fastify = {
      oidc: {
        authenticate: {
          user: async req => {
            order.push('oidc-user');
            req.userInfo = { id: 'oidc-1' };
            req.user = req.userInfo;
          },
          admin: async () => {
            order.push('oidc-admin');
          }
        }
      },
      account: {
        authenticate: {
          user: async () => {
            order.push('account-user');
          },
          admin: async () => {
            order.push('account-admin');
          }
        }
      }
    };
    await requireLocalAdmin(fastify, request);
    expect(order).to.deep.equal(['oidc-user', 'oidc-admin']);
  });
});
