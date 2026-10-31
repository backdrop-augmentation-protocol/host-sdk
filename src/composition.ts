export type LayoutMode = 'manual' | 'grid';
export type Anchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
export interface ManualLayout {
  mode: 'manual'; anchor: Anchor; x: number; y: number; width: number; height: number;
  scale: number; rotation: number; opacity: number; zIndex: number; locked: boolean;
}
export interface AutomaticLayout { mode: 'automatic'; order: number; scale: number; rotation: number; opacity: number; zIndex: number; locked: boolean; }
export type ComponentLayout = ManualLayout | AutomaticLayout;
export interface GridSettings { columns: number; gapX: number; gapY: number; paddingX: number; paddingY: number; }
export interface Viewport { width: number; height: number; }
export interface ResolvedLayout { x: number; y: number; width: number; height: number; anchor: Anchor; scale: number; rotation: number; opacity: number; zIndex: number; }

const anchors: Record<Anchor, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0], left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

export function validateComponentLayout(layout: ComponentLayout): void {
  if (layout.mode === 'manual') {
    if (!(layout.anchor in anchors) || !Number.isFinite(layout.x) || !Number.isFinite(layout.y) || Math.abs(layout.x) > 2 || Math.abs(layout.y) > 2 ||
      !(layout.width > 0 && layout.width <= 2) || !(layout.height > 0 && layout.height <= 2)) throw new TypeError('Invalid manual component layout');
  } else if (!Number.isInteger(layout.order) || layout.order < 0) throw new TypeError('Invalid automatic component layout order');
  if (!(layout.scale >= 0.1 && layout.scale <= 5) || !Number.isFinite(layout.rotation) || Math.abs(layout.rotation) > 360 ||
    !(layout.opacity >= 0 && layout.opacity <= 1) || !Number.isInteger(layout.zIndex) || Math.abs(layout.zIndex) > 100000 || typeof layout.locked !== 'boolean')
    throw new TypeError('Invalid component layout transform');
}

export function resolveLayouts(layouts: ReadonlyMap<string, ComponentLayout>, mode: LayoutMode, grid: GridSettings | undefined, viewport: Viewport): Map<string, ResolvedLayout> {
  if (!(viewport.width > 0 && viewport.height > 0 && Number.isFinite(viewport.width) && Number.isFinite(viewport.height))) throw new TypeError('Viewport dimensions must be positive finite numbers');
  const resolved = new Map<string, ResolvedLayout>();
  if (mode === 'manual') {
    for (const [id, layout] of layouts) {
      validateComponentLayout(layout);
      if (layout.mode !== 'manual') throw new TypeError(`Instance ${id} requires manual layout in manual mode`);
      resolved.set(id, { x: layout.x, y: layout.y, width: layout.width, height: layout.height, anchor: layout.anchor, scale: layout.scale, rotation: layout.rotation, opacity: layout.opacity, zIndex: layout.zIndex });
    }
    return resolved;
  }
  if (!grid || !Number.isInteger(grid.columns) || grid.columns < 1 || grid.columns > 32 ||
    !Number.isFinite(grid.gapX) || grid.gapX < 0 || grid.gapX > 0.25 || !Number.isFinite(grid.gapY) || grid.gapY < 0 || grid.gapY > 0.25 ||
    !Number.isFinite(grid.paddingX) || grid.paddingX < 0 || grid.paddingX > 0.5 || !Number.isFinite(grid.paddingY) || grid.paddingY < 0 || grid.paddingY > 0.5) throw new TypeError('Invalid grid settings');
  const automatic: Array<[string, AutomaticLayout]> = [];
  const lockedManual: Array<[string, ManualLayout]> = [];
  for (const [id, layout] of layouts) {
    if (layout.mode === 'automatic') automatic.push([id, layout]);
    else lockedManual.push([id, layout]);
  }
  automatic.sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]));
  for (const [id, layout] of lockedManual) {
    validateComponentLayout(layout);
    if (!layout.locked) throw new TypeError(`Manual instance ${id} must be locked in grid mode`);
    resolved.set(id, { x: layout.x, y: layout.y, width: layout.width, height: layout.height, anchor: layout.anchor, scale: layout.scale, rotation: layout.rotation, opacity: layout.opacity, zIndex: layout.zIndex });
  }
  for (const [id, layout] of automatic) validateComponentLayout(layout);
  if (grid.paddingX * 2 + grid.gapX * Math.max(0, grid.columns - 1) >= 1 ||
    grid.paddingY * 2 + grid.gapY * Math.max(0, Math.ceil(automatic.length / grid.columns) - 1) >= 1) throw new TypeError('Grid gaps and padding leave no usable canvas');
  const rows = Math.ceil(automatic.length / grid.columns);
  const cellWidth = automatic.length ? (1 - 2 * grid.paddingX - grid.gapX * (grid.columns - 1)) / grid.columns : 0;
  const cellHeight = rows ? (1 - 2 * grid.paddingY - grid.gapY * (rows - 1)) / rows : 0;
  automatic.forEach(([id, layout], index) => {
    const column = index % grid.columns;
    const row = Math.floor(index / grid.columns);
    resolved.set(id, { x: grid.paddingX + column * (cellWidth + grid.gapX), y: grid.paddingY + row * (cellHeight + grid.gapY), width: cellWidth, height: cellHeight, anchor: 'top-left', scale: layout.scale, rotation: layout.rotation, opacity: layout.opacity, zIndex: layout.zIndex });
  });
  return resolved;
}

export function anchorOrigin(anchor: Anchor): [number, number] { return anchors[anchor]; }
