# 上游来源说明

本目录的源码复制自 EasyTier 官方仓库的 `easytier-js` 工作区。

- 上游路径：`其他项目代码/EasyTier/easytier-js`（只读参考，本项目不修改它）
- 同步文件数：32
- 同步脚本：`scripts/sync-upstream.mjs`

## 本项目的改动

本项目对上游代码做了最小必要改动，改动点集中记录，便于对照升级：

1. `runtime/src/config.ts` —— 增加传输相关配置项，使浏览器 profile 可在
   P2P 可用时不再强制 `disable_p2p`（阶段 5）。
2. `runtime/src/websocket-host.ts` —— 登记 WebRTC 相关的 host 导入实现
   （阶段 5）；此前这些导入固定返回 `HOST_UNSUPPORTED`。
3. `runtime/src/rtc-host.ts`、`runtime/src/transport/` —— 本项目新增文件，
   同步脚本会保留，不会被上游覆盖。

## 保留路径（同步时不会被覆盖）


