# BAP Host SDK

[English](README.md) | [简体中文](README.zh-CN.md)

Minimal TypeScript Web Host runtime for BAP Embedded Mode components.

Install with `npm install @backdrop-augmentation-protocol/host-sdk`.

The MVP provides:

- iframe + `postMessage` isolation;
- handshake and capability negotiation;
- lifecycle, size, pause and resume propagation;
- per-component fault isolation;
- a small adapter boundary for Wallpaper Engine.

For Wallpaper Engine, mount a self-contained embedded document received from
the Companion without creating another wallpaper project:

```js
host.mount({ id: manifest.id, srcdoc: embeddedHtml, container });
```

`srcdoc` frames use `sandbox="allow-scripts"` and an opaque origin. The SDK
checks the frame window and accepts only that frame's `null` origin for BAP
messages. A URL-backed `src` frame remains available for other environments.
Provide exactly one of `src` and `srcdoc`.

The message mapping follows the normative
[`spec`](https://github.com/backdrop-augmentation-protocol/spec) schemas and profiles.

```sh
npm install
npm test
npm run build
```
