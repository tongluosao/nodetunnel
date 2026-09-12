/**
 * Worker 侧的补充类型声明。
 *
 * 背景：本项目的 Worker 直接以 TypeScript 源码方式引用 vendored 的
 * `@easytier/cloudflare` 与 `@easytier/runtime`（见 packages/easytier-js/UPSTREAM.md），
 * 因此它们的类型会一并参与本项目的类型检查。需要补充两类声明：
 *
 *  1. `.wasm` 模块导入 —— 由 wrangler 的 CompiledWasm 规则编译为 WebAssembly.Module；
 *  2. JSPI 的 WebAssembly.Suspending / promising —— 上游 runtime 依赖，
 *     而 @cloudflare/workers-types 自带的 WebAssembly 命名空间未包含它们。
 */

declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare namespace WebAssembly {
  type JspiCallable = (...parameters: never[]) => unknown;

  class Suspending extends Function {
    constructor(callable: (...parameters: never[]) => Promise<number>);
  }

  function promising<T extends JspiCallable>(
    callable: T,
  ): (...parameters: Parameters<T>) => Promise<Awaited<ReturnType<T>>>;
}
