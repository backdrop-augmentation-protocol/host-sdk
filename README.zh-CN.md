# BAP Host SDK

[English](README.md) | 简体中文

面向 BAP Embedded Mode 组件的最小 TypeScript Web Host 运行时。

MVP 提供：

- iframe + `postMessage` 隔离；
- 握手与能力协商；
- 生命周期、尺寸、暂停和恢复传播；
- 单组件故障隔离；
- Wallpaper Engine 适配边界。

消息信封集中保存在 `src/protocol.ts` 中。它只是传输映射，不是第二套协议
定义。规范性 Schema 和 Profile 名称应来自发布后的同级 [`spec`](../spec)
仓库。

```sh
npm install
npm test
npm run build
```
