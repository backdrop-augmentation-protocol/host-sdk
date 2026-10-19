import {
  HelloPayload, Message, PROTOCOL_VERSION, isMessage, messageNames
} from './protocol.js';

export type ComponentState = 'created' | 'handshaking' | 'ready' | 'paused' | 'stopped' | 'failed';
export interface Size { width: number; height: number; devicePixelRatio?: number }
export interface HostOptions {
  implementation?: string;
  version?: string;
  capabilities?: string[];
  handshakeTimeoutMs?: number;
  targetOrigin?: string;
  window?: Window;
  document?: Document;
}
export interface ComponentOptions {
  id: string;
  src: string;
  container: HTMLElement;
  size?: Size;
  allowedOrigin?: string;
}
type Listener = (value: unknown) => void;

function id(prefix: string): string { return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`; }

export class ComponentHandle {
  readonly id: string;
  readonly iframe: HTMLIFrameElement;
  state: ComponentState = 'created';
  capabilities: string[] = [];
  readonly allowedOrigin?: string;
  private readonly listeners = new Map<string, Set<Listener>>();
  private handshakeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly host: HostRuntime, options: ComponentOptions) {
    this.id = options.id;
    this.allowedOrigin = options.allowedOrigin;
    const document = host.document;
    this.iframe = document.createElement('iframe');
    this.iframe.src = options.src;
    this.iframe.title = `BAP component ${options.id}`;
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    this.iframe.style.border = '0';
    this.iframe.style.display = 'block';
    this.iframe.addEventListener('load', () => this.beginHandshake());
    this.iframe.addEventListener('error', () => this.fail('iframe_error', 'Component iframe failed to load'));
    if (options.size) this.setSize(options.size);
    options.container.appendChild(this.iframe);
    this.state = 'handshaking';
    this.handshakeTimer = setTimeout(() => {
      if (this.state === 'handshaking') this.fail('handshake_timeout', 'Component handshake timed out');
    }, host.handshakeTimeoutMs);
  }

  on(name: string, listener: Listener): () => void {
    const set = this.listeners.get(name) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(name, set);
    return () => set.delete(listener);
  }

  setSize(size: Size): void {
    this.iframe.style.width = `${size.width}px`; this.iframe.style.height = `${size.height}px`;
    this.sendEvent(messageNames.sizeChanged, size);
  }

  pause(): void { if (this.state === 'ready') { this.state = 'paused'; this.sendEvent(messageNames.paused, { paused: true }); } }
  resume(): void { if (this.state === 'paused') { this.state = 'ready'; this.sendEvent(messageNames.resumed, { paused: false }); } }
  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped'; clearTimeout(this.handshakeTimer);
    this.sendEvent(messageNames.lifecycle, { state: 'stopped' });
    this.iframe.remove(); this.emit('stopped', undefined);
  }

  private beginHandshake(): void {
    if (this.state !== 'handshaking') return;
    this.send({ kind: 'request', name: messageNames.hostHello, payload: this.host.hello() });
  }

  receive(message: Message): void {
    if (message.name === messageNames.componentHello && message.kind === 'response') {
      const payload = message.payload as HelloPayload | undefined;
      if (!payload || payload.role !== 'component') return this.fail('invalid_hello', 'Invalid component hello');
      clearTimeout(this.handshakeTimer); this.capabilities = payload.capabilities ?? [];
      this.state = 'ready'; this.emit('ready', payload); this.sendEvent(messageNames.lifecycle, { state: 'started' });
      return;
    }
    if (message.name === messageNames.fault) return this.fail('component_fault', String((message.payload as { message?: string })?.message ?? 'Component reported a fault'));
    this.emit(message.name, message.payload);
  }

  acceptsOrigin(origin: string): boolean {
    return !this.allowedOrigin || this.allowedOrigin === '*' || origin === this.allowedOrigin;
  }

  private sendEvent(name: string, payload: unknown): void { this.send({ kind: 'event', name, payload }); }
  private send(partial: Pick<Message, 'kind' | 'name' | 'payload'>): void {
    const target = this.iframe.contentWindow;
    if (!target) return;
    target.postMessage({ bap: 'message', id: id('msg'), protocolVersion: PROTOCOL_VERSION, ...partial } satisfies Message, this.host.targetOrigin);
  }
  private fail(code: string, message: string): void {
    if (this.state === 'failed' || this.state === 'stopped') return;
    clearTimeout(this.handshakeTimer); this.state = 'failed';
    this.iframe.style.display = 'none'; this.emit('fault', { code, message }); this.host.emit('componentFault', { id: this.id, code, message });
  }
  private emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
}

export class HostRuntime {
  readonly document: Document;
  readonly targetOrigin: string;
  readonly handshakeTimeoutMs: number;
  private readonly options: Required<Pick<HostOptions, 'implementation' | 'version' | 'capabilities'>>;
  private readonly components = new Map<string, ComponentHandle>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly messageListener: (event: MessageEvent) => void;

  constructor(options: HostOptions = {}) {
    const win = options.window ?? globalThis.window;
    this.document = options.document ?? win?.document;
    if (!this.document) throw new Error('HostRuntime requires a browser document');
    this.targetOrigin = options.targetOrigin ?? '*'; this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.options = { implementation: options.implementation ?? 'bap-host-sdk', version: options.version ?? '0.1.0', capabilities: options.capabilities ?? ['lifecycle', 'size', 'pause-resume'] };
    this.messageListener = (event) => this.receive(event);
    win?.addEventListener('message', this.messageListener);
  }

  hello(): HelloPayload { return { role: 'host', ...this.options }; }
  on(name: string, listener: Listener): () => void { const set = this.listeners.get(name) ?? new Set<Listener>(); set.add(listener); this.listeners.set(name, set); return () => set.delete(listener); }
  emit(name: string, value: unknown): void { for (const listener of this.listeners.get(name) ?? []) listener(value); }
  mount(options: ComponentOptions): ComponentHandle { if (this.components.has(options.id)) throw new Error(`Component already mounted: ${options.id}`); const handle = new ComponentHandle(this, options); this.components.set(options.id, handle); handle.on('stopped', () => this.components.delete(options.id)); return handle; }
  get(id: string): ComponentHandle | undefined { return this.components.get(id); }
  pauseAll(): void { for (const component of this.components.values()) component.pause(); }
  resumeAll(): void { for (const component of this.components.values()) component.resume(); }
  resizeAll(size: Size): void { for (const component of this.components.values()) component.setSize(size); }
  destroy(): void { for (const component of this.components.values()) component.stop(); this.components.clear(); }
  private receive(event: MessageEvent): void {
    if (!isMessage(event.data)) return;
    for (const component of this.components.values()) {
      if (event.source === component.iframe.contentWindow && component.acceptsOrigin(event.origin)) { component.receive(event.data); return; }
    }
  }
}
