import { BapError, HelloAckResult, HelloPayload, Manifest, Message, PROTOCOL, event, isBapMessage, isManifest, request } from './protocol.js';

export type ComponentState = 'created' | 'connected' | 'initialized' | 'running' | 'paused' | 'stopped' | 'failed';
export interface Size { width: number; height: number; devicePixelRatio?: number }
export interface HostOptions { implementationId?: string; implementationName?: string; implementationVersion?: string; capabilities?: string[]; permissions?: string[]; handshakeTimeoutMs?: number; targetOrigin?: string; window?: Window; document?: Document; }
export interface ComponentOptions { id: string; src?: string; srcdoc?: string; container: HTMLElement; size?: Size; allowedOrigin?: string; }
type Listener = (value: unknown) => void;
const bapError = (code: BapError['code'], message: string, details?: Record<string, unknown>): BapError => ({ code, message, ...(details ? { details } : {}) });

export class ComponentHandle {
  readonly iframe: HTMLIFrameElement;
  state: ComponentState = 'created';
  capabilities: string[] = [];
  grantedPermissions: string[] = [];
  sessionId?: string;
  private helloRequestId?: string;
  private readonly pendingRequests = new Map<string, 'initialize' | 'start' | 'pause' | 'resume' | 'stop'>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private expectedOrigin: string;
  private readonly fileSource: boolean;
  private readonly inlineSource: boolean;

  constructor(private readonly host: HostRuntime, readonly id: string, options: ComponentOptions) {
    this.inlineSource = options.srcdoc !== undefined;
    if (this.inlineSource === (options.src !== undefined)) throw new TypeError('Exactly one of src or srcdoc is required');
    if (this.inlineSource && (typeof options.srcdoc !== 'string' || !options.srcdoc.trim())) throw new TypeError('srcdoc must be non-empty HTML');
    if (this.inlineSource && options.allowedOrigin !== undefined && options.allowedOrigin !== 'null') throw new TypeError('srcdoc requires an opaque origin');
    this.fileSource = !this.inlineSource && new URL(options.src!, host.document.baseURI).protocol === 'file:';
    this.expectedOrigin = this.inlineSource ? 'null' : options.allowedOrigin ?? host.targetOrigin;
    if (!this.inlineSource && this.expectedOrigin === '*') { try { this.expectedOrigin = new URL(options.src!, host.document.baseURI).origin; } catch { /* test document */ } }
    const document = host.document;
    this.iframe = document.createElement('iframe');
    if (this.inlineSource) this.iframe.srcdoc = options.srcdoc!; else this.iframe.src = options.src!;
    this.iframe.title = `BAP component ${options.id}`;
    this.iframe.setAttribute('sandbox', this.inlineSource ? 'allow-scripts' : 'allow-scripts allow-same-origin'); this.iframe.style.border = '0'; this.iframe.style.display = 'block';
    this.iframe.addEventListener('load', () => this.beginHandshake()); this.iframe.addEventListener('error', () => this.fail(bapError('INTERNAL_ERROR', 'Component iframe failed to load')));
    if (options.size) this.setSize(options.size); options.container.appendChild(this.iframe);
    this.handshakeTimer = setTimeout(() => { if (this.state === 'created' || this.state === 'connected') this.fail(bapError('TIMEOUT', 'Component load or handshake timed out', { id: this.id })); }, host.handshakeTimeoutMs);
  }
  on(name: string, listener: Listener): () => void { const set = this.listeners.get(name) ?? new Set<Listener>(); set.add(listener); this.listeners.set(name, set); return () => set.delete(listener); }
  setSize(size: Size): void { this.iframe.style.width = `${size.width}px`; this.iframe.style.height = `${size.height}px`; if (['initialized', 'running', 'paused'].includes(this.state)) this.sendEvent('host.size.changed', size); }
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
  private beginHandshake(): void { if (this.state !== 'created') return; this.state = 'connected'; const hello = request('hello', this.host.hello()); this.helloRequestId = hello.id; this.send(hello); }
  private handleHelloResponse(message: Message): void {
    if (message.ok !== true || !message.result) return this.fail(message.error ?? bapError('INVALID_MESSAGE', 'Invalid helloAck response'));
    const result = message.result as unknown as HelloAckResult;
    if (result.selectedProtocol?.name !== PROTOCOL.name || result.selectedProtocol.version !== PROTOCOL.version || result.selectedProtocol.profile !== PROTOCOL.profile || result.role !== 'component' || !message.sessionId || !Array.isArray(result.capabilities) || !Array.isArray(result.permissions)) return this.fail(bapError('INVALID_MESSAGE', 'Invalid helloAck result'));
    if (result.capabilities.some(capability => !this.host.hello().capabilities.includes(capability)) || result.permissions.some(permission => !this.host.hello().requestedPermissions.includes(permission))) return this.fail(bapError('CAPABILITY_DENIED', 'Acknowledgement grants unrequested capability or permission'));
    clearTimeout(this.handshakeTimer); this.sessionId = message.sessionId; this.capabilities = result.capabilities; this.grantedPermissions = result.permissions; this.sendLifecycle('initialize');
  }
  private handleLifecycleResponse(message: Message): void {
    if (message.ok !== true || !message.result) return this.fail(message.error ?? bapError('INVALID_MESSAGE', 'Invalid lifecycle response'));
    const method = message.correlationId ? this.pendingRequests.get(message.correlationId) : undefined;
    if (!method) return;
    this.pendingRequests.delete(message.correlationId!);
    if (method === 'initialize' && this.state === 'connected') { this.state = 'initialized'; this.sendLifecycle('start'); return; }
    if (method === 'start' && this.state === 'initialized') { this.state = 'running'; this.emit('ready', { capabilities: this.capabilities }); return; }
    if (method === 'pause' && this.state === 'running') { this.state = 'paused'; this.emit('paused', undefined); return; }
    if (method === 'resume' && this.state === 'paused') { this.state = 'running'; this.emit('resumed', undefined); return; }
    if (method === 'stop') this.finishStop();
  }
  private sendLifecycle(method: 'initialize' | 'start' | 'pause' | 'resume' | 'stop'): void { const message = request(method, {}, this.sessionId); this.pendingRequests.set(message.id, method); this.send(message); }
  private sendEvent(name: string, payload: object): void { this.send(event(name, payload, this.sessionId)); }
  private send(message: Message): void { this.iframe.contentWindow?.postMessage(message, this.inlineSource ? '*' : this.host.targetOrigin); }
  private finishStop(): void { if (this.state === 'stopped') return; clearTimeout(this.handshakeTimer); this.state = 'stopped'; this.iframe.remove(); this.emit('stopped', undefined); }
  private fail(fault: BapError): void { if (this.state === 'failed' || this.state === 'stopped') return; clearTimeout(this.handshakeTimer); this.state = 'failed'; this.iframe.style.display = 'none'; this.emit('fault', fault); this.host.emit('componentFault', { id: this.id, error: fault }); }
  private emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

export class HostRuntime {
  readonly document: Document; readonly targetOrigin: string; readonly handshakeTimeoutMs: number;
  readonly manifest: Manifest;
  private readonly options: Required<Pick<HostOptions, 'implementationId' | 'implementationName' | 'implementationVersion' | 'capabilities' | 'permissions'>>;
  private readonly components = new Map<string, ComponentHandle>(); private readonly listeners = new Map<string, Set<Listener>>(); private readonly messageListener: (event: MessageEvent) => void;
  constructor(options: HostOptions = {}) {
    const win = options.window ?? globalThis.window; this.document = options.document ?? win?.document; if (!this.document) throw new Error('HostRuntime requires a browser document');
    this.targetOrigin = options.targetOrigin ?? '*'; this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.options = { implementationId: options.implementationId ?? 'bap.host-sdk', implementationName: options.implementationName ?? 'BAP Host SDK', implementationVersion: options.implementationVersion ?? '0.1.0', capabilities: options.capabilities ?? ['lifecycle', 'size', 'pause-resume'], permissions: options.permissions ?? [] };
    this.manifest = { protocol: PROTOCOL, id: this.options.implementationId, name: this.options.implementationName, version: this.options.implementationVersion, implementationVersion: this.options.implementationVersion, role: 'host', capabilities: this.options.capabilities, permissions: this.options.permissions, entrypoints: { default: 'index.html' }, configScopes: ['global', 'wallpaper'] };
    if (!isManifest(this.manifest)) throw new Error('Invalid Host manifest');
    this.messageListener = (event) => this.receive(event); win?.addEventListener('message', this.messageListener);
  }
  hello(): HelloPayload { return { role: 'host', identity: { id: this.options.implementationId, name: this.options.implementationName, version: this.options.implementationVersion }, protocolVersions: [PROTOCOL.version], capabilities: this.options.capabilities, requestedPermissions: this.options.permissions }; }
  on(name: string, listener: Listener): () => void { const set = this.listeners.get(name) ?? new Set<Listener>(); set.add(listener); this.listeners.set(name, set); return () => set.delete(listener); }
  emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
  mount(options: ComponentOptions): ComponentHandle { if (this.components.has(options.id)) throw new Error(`Component already mounted: ${options.id}`); const handle = new ComponentHandle(this, options.id, options); this.components.set(options.id, handle); handle.on('stopped', () => this.components.delete(options.id)); return handle; }
  get(id: string): ComponentHandle | undefined { return this.components.get(id); }
  unmount(id: string): void { this.components.get(id)?.dispose(); }
  pauseAll(): void { for (const component of this.components.values()) component.pause(); }
  resumeAll(): void { for (const component of this.components.values()) component.resume(); }
  resizeAll(size: Size): void { for (const component of this.components.values()) component.setSize(size); }
  destroy(): void { for (const component of this.components.values()) component.dispose(); this.components.clear(); }
  private receive(event: MessageEvent): void { if (!isBapMessage(event.data)) return; for (const component of this.components.values()) if (event.source === component.iframe.contentWindow && component.acceptsOrigin(event.origin)) { component.receive(event.data); return; } }
}
