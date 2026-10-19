/** Type-safe transport mapping for the normative BAP Core Profile. */
export const PROTOCOL = Object.freeze({ name: 'bap', version: '0.1.0', profile: 'core' });
export type Protocol = typeof PROTOCOL;
export type MessageKind = 'request' | 'response' | 'event';
export type Role = 'host' | 'component' | 'companion';
export type ErrorCode = 'INVALID_MESSAGE' | 'UNSUPPORTED_VERSION' | 'UNSUPPORTED_PROFILE' | 'UNAUTHORIZED' | 'CAPABILITY_DENIED' | 'INVALID_STATE' | 'NOT_FOUND' | 'CONFLICT' | 'TIMEOUT' | 'INTERNAL_ERROR';
export interface BapError { code: ErrorCode; message: string; retryable?: boolean; details?: Record<string, unknown>; }
export interface Message<T = object> { protocol: Protocol; kind: MessageKind; id: string; sessionId?: string; correlationId?: string; timestamp: string; method?: string; event?: string; payload?: T; ok?: boolean; result?: Record<string, unknown>; error?: BapError; }
export interface HelloPayload { role: Role; implementation: { id: string; name: string; version: string }; supportedProtocols: Array<{ name: 'bap'; version: string; profile: string }>; capabilities: string[]; requestedPermissions: string[]; }
export interface HelloAckResult { protocol: Protocol; capabilities: string[]; permissions: string[]; sessionId: string; }
export interface Manifest {
  protocol: Protocol;
  id: string;
  name: string;
  version: string;
  implementationVersion?: string;
  role: Role;
  capabilities: string[];
  permissions?: string[];
  modes?: Array<'standalone' | 'embedded'>;
  entrypoints: { default: string; standalone?: string; embedded?: string };
  configScopes?: Array<'global' | 'series' | 'wallpaper' | 'instance'>;
  description?: string;
}
export const CORE_METHODS = ['hello', 'initialize', 'start', 'pause', 'resume', 'stop'] as const;
export const CORE_EVENTS = ['state.changed', 'capability.changed', 'config.changed', 'diagnostic'] as const;
export function now(): string { return new Date().toISOString(); }
export function messageId(prefix = 'msg'): string { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
export function request<T extends object>(method: string, payload: T, sessionId?: string): Message<T> { return { protocol: PROTOCOL, kind: 'request', id: messageId('req'), timestamp: now(), method, payload, ...(sessionId ? { sessionId } : {}) }; }
export function event<T extends object>(name: string, payload: T, sessionId?: string, correlationId?: string): Message<T> { return { protocol: PROTOCOL, kind: 'event', id: messageId('evt'), timestamp: now(), event: name, payload, ...(sessionId ? { sessionId } : {}), ...(correlationId ? { correlationId } : {}) }; }
export function isBapMessage(value: unknown): value is Message { if (!value || typeof value !== 'object') return false; const message = value as Partial<Message>; return !!message.protocol && message.protocol.name === 'bap' && typeof message.protocol.version === 'string' && typeof message.protocol.profile === 'string' && ['request', 'response', 'event'].includes(String(message.kind)) && typeof message.id === 'string' && typeof message.timestamp === 'string'; }
export function isErrorCode(value: unknown): value is ErrorCode { return ['INVALID_MESSAGE', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_PROFILE', 'UNAUTHORIZED', 'CAPABILITY_DENIED', 'INVALID_STATE', 'NOT_FOUND', 'CONFLICT', 'TIMEOUT', 'INTERNAL_ERROR'].includes(String(value)); }
export function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<Manifest>;
  const protocol = manifest.protocol as Partial<Protocol> | undefined;
  const entrypoints = manifest.entrypoints as Manifest['entrypoints'] | undefined;
  return protocol?.name === 'bap' && typeof protocol.version === 'string' && protocol.profile === 'core' &&
    typeof manifest.id === 'string' && /^[a-z0-9][a-z0-9._-]{1,127}$/.test(manifest.id) && typeof manifest.name === 'string' &&
    typeof manifest.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version) && manifest.role === 'host' && Array.isArray(manifest.capabilities) &&
    !!entrypoints && typeof entrypoints.default === 'string';
}
