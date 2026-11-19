/**
 * 应用运维：已登记的主平台。表名由 @kne/fastify-sequelize 按连接的表前缀生成（DB_TABLE_PREFIX 优先）。
 * 不用软删除：删除后重新登记同一平台时，originKey 唯一约束不能被已删除的行占住。
 */
module.exports = ({ DataTypes }) => ({
  name: 'appOpsPlatform',
  model: {
    originKey: {
      type: DataTypes.STRING(512),
      allowNull: false,
      unique: true,
      comment: '规范化后的主平台地址（去末尾斜杠、小写）'
    },
    installId: {
      type: DataTypes.STRING(64),
      comment: '关联安装 ID'
    },
    data: {
      type: DataTypes.JSON,
      allowNull: false,
      comment: '平台登记行内容'
    }
  },
  options: {
    paranoid: false,
    comment: '应用运维：已登记主平台'
  }
});
