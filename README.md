# BAP Host SDK

[English](README.md) | [简体中文](README.zh-CN.md)

Minimal TypeScript Web Host runtime for BAP Embedded Mode components.

Install with `npm install @backdrop-augmentation-protocol/host-sdk`.

The SDK provides:

- iframe + `postMessage` isolation;
- handshake and capability negotiation;
- lifecycle, size, pause and resume propagation;
- per-component fault isolation;
- distinct `instanceId` and `componentId` identities, including repeated instances of one component;
- optional exact-version extension negotiation;
- stable outer containers for normalized manual/grid layout and presentation visibility separate from Core lifecycle;
- a small adapter boundary for Wallpaper Engine.

For Wallpaper Engine, mount a self-contained embedded document received from
the Companion without creating another wallpaper project:

```js
host.mount({ instanceId: 'clock-primary', componentId: manifest.id, srcdoc: embeddedHtml, container });
```

The Host can inspect its own live Component inventory without consulting preset state:

```ts
const instances = host.getComponentInstances();
console.log(host.componentCount, instances);
```

The inventory includes every mounted instance (including loading, paused, and failed instances), with its stable instance/package IDs, runtime state, layout, presentation flags, effective config, and config revision. Each call returns detached snapshots; changing a snapshot does not mutate the running Host. `host.get(instanceId)` remains available when direct control of a particular `ComponentHandle` is needed.

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
