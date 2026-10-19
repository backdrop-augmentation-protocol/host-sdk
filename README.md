# BAP Host SDK

Minimal TypeScript Web Host runtime for BAP Embedded Mode components.

The MVP provides:

- iframe + `postMessage` isolation;
- handshake and capability negotiation;
- lifecycle, size, pause and resume propagation;
- per-component fault isolation;
- a small adapter boundary for Wallpaper Engine.

The message envelope is intentionally kept in one file (`src/protocol.ts`). It
is a transport mapping, not a second protocol definition. Normative schemas
and profile names must come from the sibling [`spec`](../spec) repository when
they are published.

```sh
npm install
npm test
npm run build
```
