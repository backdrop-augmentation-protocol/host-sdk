import { BapError, ExtensionOffer, HelloAckResult, HelloPayload, Manifest, Message, PROTOCOL, SelectedExtension, event, isBapMessage, isManifest, request } from './protocol.js';
import { ComponentLayout, GridSettings, LayoutMode, ResolvedLayout, Viewport, anchorOrigin, resolveLayouts, validateComponentLayout } from './composition.js';

export type ComponentState = 'created' | 'connected' | 'initialized' | 'running' | 'paused' | 'stopped' | 'failed';
export interface Size { width: number; height: number; devicePixelRatio?: number }
export interface HostOptions { implementationId?: string; implementationName?: string; implementationVersion?: string; capabilities?: string[]; permissions?: string[]; extensions?: ExtensionOffer[]; handshakeTimeoutMs?: number; targetOrigin?: string; viewport?: Viewport; window?: Window; document?: Document; }
export interface PresentationState { enabled: boolean; userVisible: boolean; sceneAllowed: boolean; }
export interface ComponentOptions { instanceId?: string; componentId?: string; sourceKey?: string; /** @deprecated Use instanceId and componentId separately. */ id?: string; src?: string; srcdoc?: string; container: HTMLElement; size?: Size; allowedOrigin?: string; layout?: ComponentLayout; presentation?: Partial<PresentationState>; }
type Listener = (value: unknown) => void;
const bapError = (code: BapError['code'], message: string, details?: Record<string, unknown>): BapError => ({ code, message, ...(details ? { details } : {}) });

export class ComponentHandle {
  readonly iframe: HTMLIFrameElement;
  readonly wrapper: HTMLElement;
  readonly instanceId: string;
  readonly componentId: string;
  readonly sourceKey?: string;
  state: ComponentState = 'created';
  capabilities: string[] = [];
  grantedPermissions: string[] = [];
  selectedExtensions: SelectedExtension[] = [];
  sessionId?: string;
  private helloRequestId?: string;
  private readonly pendingRequests = new Map<string, 'initialize' | 'start' | 'pause' | 'resume' | 'stop'>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private expectedOrigin: string;
  private readonly fileSource: boolean;
  private readonly inlineSource: boolean;
  private layout?: ComponentLayout;
  private renderedLayout = false;
  private presentationConfigured = false;
  private presentation: PresentationState = { enabled: true, userVisible: true, sceneAllowed: true };
  private lastRenderedSize?: Size;
  private lastEffectiveVisibility?: boolean;
  private requestedSize?: Size;

  constructor(private readonly host: HostRuntime, options: ComponentOptions) {
    this.instanceId = options.instanceId ?? options.id ?? '';
    this.componentId = options.componentId ?? options.id ?? this.instanceId;
    this.sourceKey = options.sourceKey;
    if (!this.instanceId.trim()) throw new TypeError('instanceId is required');
    if (!this.componentId.trim()) throw new TypeError('componentId is required');
    this.inlineSource = options.srcdoc !== undefined;
    if (this.inlineSource === (options.src !== undefined)) throw new TypeError('Exactly one of src or srcdoc is required');
    if (this.inlineSource && (typeof options.srcdoc !== 'string' || !options.srcdoc.trim())) throw new TypeError('srcdoc must be non-empty HTML');
    if (this.inlineSource && options.allowedOrigin !== undefined && options.allowedOrigin !== 'null') throw new TypeError('srcdoc requires an opaque origin');
    this.fileSource = !this.inlineSource && new URL(options.src!, host.document.baseURI).protocol === 'file:';
    this.expectedOrigin = this.inlineSource ? 'null' : options.allowedOrigin ?? host.targetOrigin;
    if (!this.inlineSource && this.expectedOrigin === '*') { try { this.expectedOrigin = new URL(options.src!, host.document.baseURI).origin; } catch { /* test document */ } }
    const document = host.document;
    this.wrapper = document.createElement('div');
    this.wrapper.style.display = 'contents';
    this.iframe = document.createElement('iframe');
    if (this.inlineSource) this.iframe.srcdoc = options.srcdoc!; else this.iframe.src = options.src!;
    this.iframe.title = `BAP component ${this.componentId} (${this.instanceId})`;
    this.iframe.setAttribute('sandbox', this.inlineSource ? 'allow-scripts' : 'allow-scripts allow-same-origin'); this.iframe.style.border = '0'; this.iframe.style.display = 'block';
    this.iframe.addEventListener('load', () => this.beginHandshake()); this.iframe.addEventListener('error', () => this.fail(bapError('INTERNAL_ERROR', 'Component iframe failed to load')));
    this.wrapper.appendChild(this.iframe);
    options.container.appendChild(this.wrapper);
    if (options.size) this.setSize(options.size);
    if (options.layout) { validateComponentLayout(options.layout); this.layout = options.layout; }
    if (options.presentation) this.setPresentation(options.presentation);
    this.handshakeTimer = setTimeout(() => { if (this.state === 'created' || this.state === 'connected') this.fail(bapError('TIMEOUT', 'Component load or handshake timed out', { instanceId: this.instanceId, componentId: this.componentId })); }, host.handshakeTimeoutMs);
  }
  /** @deprecated Use instanceId. */
  get id(): string { return this.instanceId; }
  on(name: string, listener: Listener): () => void { const set = this.listeners.get(name) ?? new Set<Listener>(); set.add(listener); this.listeners.set(name, set); return () => set.delete(listener); }
  setSize(size: Size): void { this.requestedSize = size; this.iframe.style.width = this.renderedLayout ? '100%' : `${size.width}px`; this.iframe.style.height = this.renderedLayout ? '100%' : `${size.height}px`; if (['initialized', 'running', 'paused'].includes(this.state)) this.sendEvent('host.size.changed', size); }
  setLayout(layout: ComponentLayout): void { this.host.setLayout(this.instanceId, layout); }
  setPresentation(patch: Partial<PresentationState>): void { this.presentationConfigured = true; this.presentation = { ...this.presentation, ...patch }; this.updatePresentation(); }
  get layoutRecord(): ComponentLayout | undefined { return this.layout; }
  setLayoutRecord(layout: ComponentLayout): void { this.layout = layout; }
  pause(): void { if (this.state === 'running') this.sendLifecycle('pause'); }
  resume(): void { if (this.state === 'paused') this.sendLifecycle('resume'); }
  stop(): void { if (this.state === 'stopped') return; if (['initialized', 'running', 'paused'].includes(this.state)) this.sendLifecycle('stop'); else this.finishStop(); }
  dispose(): void { this.finishStop(); }
  acceptsOrigin(origin: string): boolean {
    if (this.expectedOrigin === '*' || origin === this.expectedOrigin) return true;
    // CEF and browsers disagree on which opaque origin string a file: frame
    // exposes. The iframe window identity is checked by HostRuntime.receive.
    return this.fileSource && (this.expectedOrigin === 'null' || this.expectedOrigin === 'file://')
      && (origin === 'null' || origin === 'file://' || origin === '');
  }
  receive(message: Message): void {
    if (this.sessionId && message.sessionId !== this.sessionId) return;
    if (message.kind === 'response') { if (message.correlationId === this.helloRequestId) return this.handleHelloResponse(message); return this.handleLifecycleResponse(message); }
    if (message.kind === 'event' && message.event === 'component.fault') this.fail(bapError('INTERNAL_ERROR', 'Component reported a fault', message.payload as Record<string, unknown> | undefined));
    if (message.event) this.emit(message.event, message.payload);
  }
  private beginHandshake(): void { if (this.state !== 'created') return; this.state = 'connected'; const hello = request('hello', this.host.hello(this.instanceId)); this.helloRequestId = hello.id; this.send(hello); }
  private handleHelloResponse(message: Message): void {
    if (message.ok !== true || !message.result) return this.fail(message.error ?? bapError('INVALID_MESSAGE', 'Invalid helloAck response'));
    const result = message.result as unknown as HelloAckResult;
    if (result.selectedProtocol?.name !== PROTOCOL.name || result.selectedProtocol.version !== PROTOCOL.version || result.selectedProtocol.profile !== PROTOCOL.profile || result.role !== 'component' || !message.sessionId || !Array.isArray(result.capabilities) || !Array.isArray(result.permissions)) return this.fail(bapError('INVALID_MESSAGE', 'Invalid helloAck result'));
    if (result.capabilities.some(capability => !this.host.hello().capabilities.includes(capability)) || result.permissions.some(permission => !this.host.hello().requestedPermissions.includes(permission))) return this.fail(bapError('CAPABILITY_DENIED', 'Acknowledgement grants unrequested capability or permission'));
    const selectedExtensions = result.selectedExtensions === undefined ? [] : result.selectedExtensions;
    if (!Array.isArray(selectedExtensions) || !this.host.acceptsSelectedExtensions(selectedExtensions)) return this.fail(bapError('CAPABILITY_DENIED', 'Acknowledgement selects an unoffered or invalid extension'));
    clearTimeout(this.handshakeTimer); this.sessionId = message.sessionId; this.capabilities = result.capabilities; this.grantedPermissions = result.permissions; this.selectedExtensions = selectedExtensions; this.lastEffectiveVisibility = undefined; this.sendLifecycle('initialize');
  }
  private handleLifecycleResponse(message: Message): void {
    if (message.ok !== true || !message.result) return this.fail(message.error ?? bapError('INVALID_MESSAGE', 'Invalid lifecycle response'));
    const method = message.correlationId ? this.pendingRequests.get(message.correlationId) : undefined;
    if (!method) return;
    this.pendingRequests.delete(message.correlationId!);
    if (method === 'initialize' && this.state === 'connected') { this.state = 'initialized'; this.sendLifecycle('start'); return; }
    if (method === 'start' && this.state === 'initialized') { this.state = 'running'; this.updatePresentation(); this.emit('ready', { capabilities: this.capabilities }); return; }
    if (method === 'pause' && this.state === 'running') { this.state = 'paused'; this.emit('paused', undefined); return; }
    if (method === 'resume' && this.state === 'paused') { this.state = 'running'; this.emit('resumed', undefined); return; }
    if (method === 'stop') this.finishStop();
  }
  private sendLifecycle(method: 'initialize' | 'start' | 'pause' | 'resume' | 'stop'): void { const message = request(method, {}, this.sessionId); this.pendingRequests.set(message.id, method); this.send(message); }
  private sendEvent(name: string, payload: object): void { this.send(event(name, payload, this.sessionId)); }
  private send(message: Message): void { this.iframe.contentWindow?.postMessage(message, this.inlineSource ? '*' : this.host.targetOrigin); }
  applyResolvedLayout(layout: ResolvedLayout, viewport: Viewport): void {
    if (this.state === 'failed' || this.state === 'stopped') { this.wrapper.style.display = 'none'; return; }
    const [anchorX, anchorY] = anchorOrigin(layout.anchor);
    const width = layout.width * viewport.width;
    const height = layout.height * viewport.height;
    const px = (value: number) => `${Number(value.toFixed(3))}px`;
    this.renderedLayout = true;
    Object.assign(this.wrapper.style, {
      display: 'block', position: 'absolute', left: px(layout.x * viewport.width), top: px(layout.y * viewport.height),
      width: px(width), height: px(height), transformOrigin: `${anchorX * 100}% ${anchorY * 100}%`,
      transform: `translate(${-anchorX * 100}%, ${-anchorY * 100}%) rotate(${layout.rotation}deg) scale(${layout.scale})`,
      opacity: String(layout.opacity), zIndex: String(layout.zIndex),
    });
    this.iframe.style.width = '100%';
    this.iframe.style.height = '100%';
    const size = { width, height };
    if ((!this.lastRenderedSize || this.lastRenderedSize.width !== width || this.lastRenderedSize.height !== height) && ['initialized', 'running', 'paused'].includes(this.state)) this.sendEvent('host.size.changed', size);
    this.lastRenderedSize = size;
    this.updatePresentation();
  }
  clearResolvedLayout(): void {
    if (!this.renderedLayout) return;
    this.renderedLayout = false;
    Object.assign(this.wrapper.style, { display: this.state === 'failed' || this.state === 'stopped' ? 'none' : 'contents', position: '', left: '', top: '', width: '', height: '', transform: '', transformOrigin: '', opacity: '', zIndex: '' });
    this.iframe.style.width = this.requestedSize ? `${this.requestedSize.width}px` : '';
    this.iframe.style.height = this.requestedSize ? `${this.requestedSize.height}px` : '';
    this.lastRenderedSize = undefined;
    this.updatePresentation();
  }
  private updatePresentation(): void {
    if (!this.presentationConfigured) return;
    const ready = this.state === 'running' || this.state === 'paused';
    const visible = this.presentation.enabled && this.presentation.userVisible && this.presentation.sceneAllowed && ready;
    this.wrapper.style.visibility = visible ? 'visible' : 'hidden';
    this.wrapper.style.pointerEvents = visible ? 'auto' : 'none';
    this.iframe.style.visibility = visible ? 'visible' : 'hidden';
    this.iframe.style.pointerEvents = visible ? 'auto' : 'none';
    if (visible !== this.lastEffectiveVisibility && this.selectedExtensions.some(extension => extension.id === 'org.bap.presentation'))
      this.sendEvent('presentation.visibility.changed', { instanceId: this.instanceId, visible });
    this.lastEffectiveVisibility = visible;
  }
  private finishStop(): void { if (this.state === 'stopped') return; clearTimeout(this.handshakeTimer); this.state = 'stopped'; this.wrapper.remove(); this.emit('stopped', undefined); }
  private fail(fault: BapError): void { if (this.state === 'failed' || this.state === 'stopped') return; clearTimeout(this.handshakeTimer); this.state = 'failed'; this.wrapper.style.display = 'none'; this.emit('fault', fault); this.host.emit('componentFault', { id: this.instanceId, instanceId: this.instanceId, componentId: this.componentId, error: fault }); }
  private emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

export class HostRuntime {
  readonly document: Document; readonly targetOrigin: string; readonly handshakeTimeoutMs: number;
  readonly manifest: Manifest;
  private readonly options: Required<Pick<HostOptions, 'implementationId' | 'implementationName' | 'implementationVersion' | 'capabilities' | 'permissions' | 'extensions'>>;
  private viewport: Viewport;
  private layoutMode: LayoutMode = 'manual';
  private gridSettings?: GridSettings;
  private readonly components = new Map<string, ComponentHandle>(); private readonly listeners = new Map<string, Set<Listener>>(); private readonly messageListener: (event: MessageEvent) => void;
  constructor(options: HostOptions = {}) {
    const win = options.window ?? globalThis.window; this.document = options.document ?? win?.document; if (!this.document) throw new Error('HostRuntime requires a browser document');
    this.viewport = options.viewport ?? { width: this.document.documentElement?.clientWidth || 1, height: this.document.documentElement?.clientHeight || 1 };
    this.targetOrigin = options.targetOrigin ?? '*'; this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.options = { implementationId: options.implementationId ?? 'bap.host-sdk', implementationName: options.implementationName ?? 'BAP Host SDK', implementationVersion: options.implementationVersion ?? '0.1.0', capabilities: options.capabilities ?? ['lifecycle', 'size', 'pause-resume'], permissions: options.permissions ?? [], extensions: options.extensions ?? [] };
    this.manifest = { protocol: PROTOCOL, id: this.options.implementationId, name: this.options.implementationName, version: this.options.implementationVersion, implementationVersion: this.options.implementationVersion, role: 'host', capabilities: this.options.capabilities, permissions: this.options.permissions, entrypoints: { default: 'index.html' }, configScopes: ['global', 'wallpaper'] };
    if (!isManifest(this.manifest)) throw new Error('Invalid Host manifest');
    this.messageListener = (event) => this.receive(event); win?.addEventListener('message', this.messageListener);
  }
  hello(instanceId?: string): HelloPayload { const composition = this.options.extensions.some(extension => extension.id === 'org.bap.composition'); return { role: 'host', identity: { id: this.options.implementationId, name: this.options.implementationName, version: this.options.implementationVersion }, protocolVersions: [PROTOCOL.version], capabilities: this.options.capabilities, requestedPermissions: this.options.permissions, ...(this.options.extensions.length ? { extensions: this.options.extensions } : {}), ...(composition && instanceId ? { instanceId } : {}) }; }
  acceptsSelectedExtensions(selected: SelectedExtension[]): boolean {
    const ids = new Set<string>();
    return selected.every(extension => {
      if (!extension || typeof extension.id !== 'string' || typeof extension.version !== 'string' || ids.has(extension.id)) return false;
      ids.add(extension.id);
      return this.options.extensions.some(offer => offer.id === extension.id && offer.versions.includes(extension.version));
    });
  }
  setViewport(viewport: Viewport): void { resolveLayouts(this.currentLayouts(), this.layoutMode, this.gridSettings, viewport); this.viewport = viewport; this.renderLayouts(); }
  setLayoutMode(mode: LayoutMode, grid?: GridSettings): void { const selectedGrid = mode === 'grid' ? grid : undefined; resolveLayouts(this.currentLayouts(), mode, selectedGrid, this.viewport); this.layoutMode = mode; this.gridSettings = selectedGrid; this.renderLayouts(); }
  setLayout(instanceId: string, layout: ComponentLayout): void {
    const component = this.components.get(instanceId);
    if (!component) throw new Error(`Unknown component instance: ${instanceId}`);
    validateComponentLayout(layout);
    const candidate = this.currentLayouts();
    candidate.set(instanceId, layout);
    resolveLayouts(candidate, this.layoutMode, this.gridSettings, this.viewport);
    component.setLayoutRecord(layout);
    this.renderLayouts();
  }
  on(name: string, listener: Listener): () => void { const set = this.listeners.get(name) ?? new Set<Listener>(); set.add(listener); this.listeners.set(name, set); return () => set.delete(listener); }
  emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
  mount(options: ComponentOptions): ComponentHandle { const instanceId = options.instanceId ?? options.id ?? ''; if (this.components.has(instanceId)) throw new Error(`Component instance already mounted: ${instanceId}`); const candidate = this.currentLayouts(); if (options.layout) { validateComponentLayout(options.layout); candidate.set(instanceId, options.layout); resolveLayouts(candidate, this.layoutMode, this.gridSettings, this.viewport); } const handle = new ComponentHandle(this, options); this.components.set(instanceId, handle); handle.on('stopped', () => this.components.delete(instanceId)); this.renderLayouts(); return handle; }
  get(instanceId: string): ComponentHandle | undefined { return this.components.get(instanceId); }
  unmount(instanceId: string): void { this.components.get(instanceId)?.dispose(); }
  pauseAll(): void { for (const component of this.components.values()) component.pause(); }
  resumeAll(): void { for (const component of this.components.values()) component.resume(); }
  resizeAll(size: Size): void { for (const component of this.components.values()) component.setSize(size); }
  destroy(): void { for (const component of this.components.values()) component.dispose(); this.components.clear(); }
  private currentLayouts(): Map<string, ComponentLayout> { return new Map([...this.components].flatMap(([instanceId, component]) => component.layoutRecord ? [[instanceId, component.layoutRecord] as const] : [])); }
  private renderLayouts(): void {
    const layouts = this.currentLayouts();
    if (layouts.size === 0) { for (const component of this.components.values()) component.clearResolvedLayout(); return; }
    const resolved = resolveLayouts(layouts, this.layoutMode, this.gridSettings, this.viewport);
    for (const [instanceId, component] of this.components) {
      const layout = resolved.get(instanceId);
      if (layout) component.applyResolvedLayout(layout, this.viewport); else component.clearResolvedLayout();
    }
  }
  private receive(event: MessageEvent): void { if (!isBapMessage(event.data)) return; for (const component of this.components.values()) if (event.source === component.iframe.contentWindow && component.acceptsOrigin(event.origin)) { component.receive(event.data); return; } }
}
