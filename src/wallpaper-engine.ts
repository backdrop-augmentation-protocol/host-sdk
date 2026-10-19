import { HostRuntime, Size } from './host.js';

/** Narrow boundary for the WE global callbacks; the core does not depend on WE. */
export interface WallpaperEngineAdapter {
  onSize(listener: (size: Size) => void): void;
  onPause(listener: () => void): void;
  onResume(listener: () => void): void;
  currentSize?(): Size;
}

export class WallpaperEngineHost {
  constructor(readonly runtime: HostRuntime, adapter: WallpaperEngineAdapter) {
    adapter.onSize((size) => runtime.resizeAll(size));
    adapter.onPause(() => runtime.pauseAll());
    adapter.onResume(() => runtime.resumeAll());
    const size = adapter.currentSize?.(); if (size) runtime.resizeAll(size);
  }
}
