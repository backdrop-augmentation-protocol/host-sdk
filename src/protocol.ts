/**
 * Transport mapping for the MVP.
 *
 * This is deliberately not a second schema: `spec` is authoritative. Keep
 * this mapping small and update it when the normative Core Profile lands.
 */
export const PROTOCOL_VERSION = '0.1';

export type MessageKind = 'request' | 'response' | 'event';

export interface Message<T = unknown> {
  bap: 'message';
  kind: MessageKind;
  id: string;
  name: string;
  protocolVersion: string;
  payload?: T;
  ok?: boolean;
  error?: { code: string; message: string };
}

export interface HelloPayload {
  role: 'host' | 'component';
  implementation: string;
  version: string;
  capabilities: string[];
}

export const messageNames = {
  hostHello: 'host.hello',
  componentHello: 'component.hello',
  lifecycle: 'lifecycle',
  sizeChanged: 'host.sizeChanged',
  paused: 'host.paused',
  resumed: 'host.resumed',
  fault: 'component.fault'
} as const;

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<Message>;
  return message.bap === 'message' && typeof message.id === 'string' &&
    typeof message.name === 'string' && typeof message.kind === 'string';
}
