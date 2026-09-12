import { easytierRelay } from './app.js';

/**
 * EasyTier 中继 Durable Object。
 *
 * wrangler.jsonc 的 durable_objects.migrations 中通过
 * `new_sqlite_classes: ["EasyTierRelayObject"]` 引用此类。
 * 必须导出为具名的具体类，Wrangler 才能生成绑定。
 */
export class EasyTierRelayObject extends easytierRelay.DurableObject {}
