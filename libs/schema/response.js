// 本插件的接口都以流返回 JSON（不经过序列化），响应 schema 只用于 OpenAPI 文档；
// 仍按可空、允许额外字段的写法声明，避免日后改为直接返回对象时裁掉或强转字段
const str = description => ({ type: 'string', nullable: true, description });
const num = description => ({ type: 'number', nullable: true, description });
const any = description => ({ description });
const obj = (description, properties = {}) => ({ type: 'object', nullable: true, description, additionalProperties: true, properties });

const response = (description, schema) => Object.assign({ type: 'object', additionalProperties: true }, schema, { description });

const success = (description, schema) => ({ 200: response(description, schema) });

// 非 JSON 响应：只写说明不声明结构
const raw = description => ({ 200: { description } });

module.exports = { str, num, any, obj, response, success, raw };
