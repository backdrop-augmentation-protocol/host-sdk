# BAP Host SDK

[English](README.md) | 简体中文

面向 BAP Embedded Mode 组件的最小 TypeScript Web Host 运行时。

通过 `npm install @backdrop-augmentation-protocol/host-sdk` 安装。

SDK 提供：

- iframe + `postMessage` 隔离；
- 握手与能力协商；
- 生命周期、尺寸、暂停和恢复传播；
- 单组件故障隔离；
- 分离 `instanceId` 与 `componentId`，允许同一组件创建多个实例；
- 可选的精确版本扩展协商；
- Wallpaper Engine 适配边界。

在 Wallpaper Engine 中，可将从 Companion 获取的自包含嵌入文档挂载到当前
壁纸，而无需创建另一项壁纸项目：

```js
host.mount({ instanceId: 'clock-primary', componentId: manifest.id, srcdoc: embeddedHtml, container });
```

`srcdoc` iframe 使用 `sandbox="allow-scripts"` 和不透明 Origin。SDK 校验
iframe 窗口，只接受该窗口以 `null` Origin 发送的 BAP 消息。其他环境仍可
使用 URL 形式的 `src`。`src` 与 `srcdoc` 必须且只能提供一个。

消息映射遵循 [`spec`](https://github.com/backdrop-augmentation-protocol/spec)
中的规范性 Schema 和 Profile。

```sh
npm install
npm test
npm run build
```
