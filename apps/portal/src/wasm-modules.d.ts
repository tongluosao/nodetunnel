/**
 * 门户侧补充类型声明。
 *
 * 门户直接以 TypeScript 源码引用 vendored 的 @easytier/browser 与
 * @easytier/runtime，因此需要补充它们依赖的环境类型：
 *
 *  1. `.wasm` 模块导入 —— browser 包通过 `import coreBytes from
 *     "./generated/easytier_core.wasm"` 获取内核字节，
 *     由 Vite 的 WASM 处理能力在构建期解析；
 *  2. JSPI 的 WebAssembly.Suspending / promising —— 上游 runtime 的
 *     WASI 实现依赖，浏览器的 WebAssembly 类型定义中尚未包含。
 */

declare module '*.wasm' {
  const bytes: ArrayBuffer;
  export default bytes;
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
