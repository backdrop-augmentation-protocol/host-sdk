import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRuntime } from '../dist/index.js';

class FakeWindow {
  listeners = new Map();
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(event) { this.listeners.get(event.type)?.(event); }
}
class FakeIframe {
  style = {};
  contentWindow = { messages: [], postMessage: (message, origin) => this.contentWindow.messages.push({ message, origin }) };
  listeners = new Map();
  setAttribute() {}
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  remove() { this.removed = true; }
  load() { this.listeners.get('load')?.(); }
}
class FakeDocument { createElement() { return new FakeIframe(); } }
class Container { children = []; appendChild(child) { this.children.push(child); } }

function messageFrom(handle, message) { handle.hostWindow?.dispatch({ type: 'message', source: handle.iframe.contentWindow, data: message }); }

test('mounts, handshakes, negotiates capabilities and starts lifecycle', () => {
  const window = new FakeWindow(); const document = new FakeDocument();
  const host = new HostRuntime({ window, document, handshakeTimeoutMs: 1000 });
  const container = new Container(); const component = host.mount({ id: 'clock', src: 'clock.html', container });
  component.iframe.load();
  assert.equal(component.iframe.contentWindow.messages[0].message.name, 'host.hello');
  window.dispatch({ type: 'message', source: component.iframe.contentWindow, data: { bap: 'message', kind: 'response', id: 'hello', name: 'component.hello', protocolVersion: '0.1', payload: { role: 'component', implementation: 'test', version: '1', capabilities: ['lifecycle'] } } });
  assert.equal(component.state, 'ready'); assert.deepEqual(component.capabilities, ['lifecycle']);
  assert.equal(component.iframe.contentWindow.messages.at(-1).message.name, 'lifecycle');
});

test('propagates size and pause/resume without affecting other components', () => {
  const window = new FakeWindow(); const document = new FakeDocument(); const host = new HostRuntime({ window, document });
  const a = host.mount({ id: 'a', src: 'a', container: new Container() }); const b = host.mount({ id: 'b', src: 'b', container: new Container() });
  for (const component of [a, b]) { component.iframe.load(); window.dispatch({ type: 'message', source: component.iframe.contentWindow, data: { bap: 'message', kind: 'response', id: 'x', name: 'component.hello', protocolVersion: '0.1', payload: { role: 'component', implementation: 'x', version: '1', capabilities: [] } } }); }
  host.resizeAll({ width: 800, height: 600 }); host.pauseAll(); assert.equal(a.state, 'paused'); assert.equal(b.state, 'paused'); host.resumeAll(); assert.equal(a.state, 'ready');
  assert.equal(a.iframe.style.width, '800px'); assert.equal(b.iframe.style.height, '600px');
});

test('isolates a component fault and keeps host and sibling alive', () => {
  const window = new FakeWindow(); const document = new FakeDocument(); const host = new HostRuntime({ window, document, handshakeTimeoutMs: 1000 });
  const a = host.mount({ id: 'a', src: 'a', container: new Container() }); const b = host.mount({ id: 'b', src: 'b', container: new Container() });
  let fault; host.on('componentFault', (value) => { fault = value; });
  window.dispatch({ type: 'message', source: a.iframe.contentWindow, data: { bap: 'message', kind: 'event', id: 'x', name: 'component.fault', protocolVersion: '0.1', payload: { message: 'boom' } } });
  assert.equal(a.state, 'failed'); assert.equal(a.iframe.style.display, 'none'); assert.equal(b.state, 'handshaking'); assert.equal(fault.id, 'a');
});
