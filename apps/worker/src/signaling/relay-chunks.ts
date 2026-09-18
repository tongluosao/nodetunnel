/**
 * 中继响应分片的累加器。
 *
 * 单独成模块而不是内联在信令房间里：分片合并与响应头捕获都是纯逻辑，
 * 放在这里可以脱离 Durable Object 运行时直接测试 —— 而这里恰好藏着一个
 * 会破坏所有大响应的缺陷，必须有测试守住。
 *
 * 关键不变式：**响应头只随第一个分片到达**（主机端仅在 chunkIndex === 0
 * 时附带 headers）。因此必须保留「第一个带头的分片」里的头，而不能取
 * 最后一条消息的头：取最后一条会得到空对象，于是 Content-Type 丢失；
 * 再叠加 nosniff 响应头，浏览器会直接拒绝执行脚本 ——
 * 表现为「MIME type ('') is not executable」。
 *
 * 影响面：凡是响应体超过单个分片（16 KiB）的请求都会丢头，
 * 也就是所有真实的 JS / CSS / 图片资源。
 */
export class RelayAccumulator {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private captured: Record<string, string> | undefined;

  /** 追加一个分片。空分片不计入，避免污染长度。 */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
  }

  /**
   * 捕获响应头。
   *
   * 只接受第一次出现的头：后续分片即使带了头也不覆盖，
   * 避免把首片的权威信息改写成残缺值。
   */
  captureHeaders(headers: Record<string, string> | undefined): void {
    if (headers !== undefined && this.captured === undefined) {
      this.captured = headers;
    }
  }

  /** 已累计的字节数。 */
  get byteLength(): number {
    return this.bytes;
  }

  /** 合并所有分片。没有分片时返回长度为 0 的数组。 */
  merge(): Uint8Array {
    const merged = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /** 组装出的响应头。始终返回对象，便于直接交给 Response。 */
  headers(): Record<string, string> {
    return this.captured ?? {};
  }
}
