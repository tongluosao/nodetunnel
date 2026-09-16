/**
 * 连接角色。
 *
 * 单独成模块而不是散在 room.ts 里：业务层需要在构造请求头时
 * 引用同一个常量，两边各写一份字符串字面量迟早会写错一个字母。
 */

export const ROLE_HOST = 'host';
export const ROLE_VISITOR = 'visitor';

export type ConnectionRole = typeof ROLE_HOST | typeof ROLE_VISITOR;

/**
 * 传递连接角色的请求头。
 *
 * 由业务层在完成令牌/路由校验后填入，Durable Object 只读不判。
 */
export const ROLE_HEADER = 'X-NT-Role';
