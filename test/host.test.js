import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRuntime, isManifest } from '../dist/index.js';

class FakeWindow { listeners = new Map(); addEventListener(name, fn) { this.listeners.set(name, fn); } dispatch(event) { this.listeners.get(event.type)?.(event); } }
class FakeIframe { style = {}; contentWindow = { messages: [], postMessage: (message, origin) => this.contentWindow.messages.push({ message, origin }) }; listeners = new Map(); setAttribute() {} addEventListener(name, fn) { this.listeners.set(name, fn); } remove() { this.removed = true; } load() { this.listeners.get('load')?.(); } }
class FakeDocument { baseURI = 'https://wallpaper.test/'; createElement() { return new FakeIframe(); } }
class Container { children = []; appendChild(child) { this.children.push(child); } }
const response = (id, result, sessionId = 'session-1') => ({ protocol: { name: 'bap', version: '0.1.0', profile: 'core' }, kind: 'response', id, timestamp: new Date().toISOString(), sessionId, ok: true, result });
const event = (name, payload) => ({ protocol: { name: 'bap', version: '0.1.0', profile: 'core' }, kind: 'event', id: 'event-1', timestamp: new Date().toISOString(), event: name, payload });

test('uses the Core Profile envelope and completes helloAck, initialize, and start', () => {
  const window = new FakeWindow(); const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  assert.equal(isManifest(host.manifest), true); assert.equal(host.manifest.role, 'host'); assert.deepEqual(host.manifest.configScopes, ['global', 'wallpaper']);
  const component = host.mount({ id: 'clock', src: 'https://component.test/clock.html', container: new Container(), allowedOrigin: 'https://component.test' }); component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  assert.equal(hello.kind, 'request'); assert.equal(hello.method, 'hello'); assert.equal(hello.protocol.profile, 'core'); assert.ok(hello.timestamp); assert.equal(hello.payload.role, 'host');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.id, { protocol: hello.protocol, capabilities: ['lifecycle'], permissions: [], sessionId: 'session-1' }) });
  const initialize = component.iframe.contentWindow.messages.at(-1).message; assert.equal(initialize.method, 'initialize'); assert.equal(component.state, 'connected');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(initialize.id, { method: 'initialize' }) });
  const start = component.iframe.contentWindow.messages.at(-1).message; assert.equal(start.method, 'start');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(start.id, {}) });
  assert.equal(component.state, 'running'); assert.deepEqual(component.capabilities, ['lifecycle']); host.destroy();
});

test('uses lifecycle requests for pause/resume/stop and propagates size events', () => {
  const window = new FakeWindow(); const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const component = host.mount({ id: 'a', src: 'https://component.test/a', container: new Container() }); component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.id, { protocol: hello.protocol, capabilities: [], permissions: [], sessionId: 's' }) });
  let initialize = component.iframe.contentWindow.messages.at(-1).message; window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(initialize.id, {}, 's') });
  let start = component.iframe.contentWindow.messages.at(-1).message; window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(start.id, {}, 's') });
  host.resizeAll({ width: 800, height: 600 }); assert.equal(component.iframe.style.width, '800px'); assert.equal(component.iframe.contentWindow.messages.at(-1).message.event, 'host.size.changed');
  component.pause(); let pause = component.iframe.contentWindow.messages.at(-1).message; assert.equal(pause.method, 'pause'); window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(pause.id, {}, 's') }); assert.equal(component.state, 'paused');
  component.resume(); let resume = component.iframe.contentWindow.messages.at(-1).message; window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(resume.id, {}, 's') }); assert.equal(component.state, 'running');
  component.stop(); let stop = component.iframe.contentWindow.messages.at(-1).message; assert.equal(stop.method, 'stop'); window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(stop.id, {}, 's') }); assert.equal(component.state, 'stopped');
});

test('rejects old envelopes and unauthorized origins while isolating faults', () => {
  const window = new FakeWindow(); const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const a = host.mount({ id: 'a', src: 'https://component.test/a', container: new Container() }); const b = host.mount({ id: 'b', src: 'https://component.test/b', container: new Container() }); let fault; host.on('componentFault', value => { fault = value; });
  window.dispatch({ type: 'message', origin: 'https://evil.test', source: a.iframe.contentWindow, data: event('component.fault', { message: 'ignored' }) }); assert.equal(a.state, 'created');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: a.iframe.contentWindow, data: event('component.fault', { message: 'boom' }) }); assert.equal(a.state, 'failed'); assert.equal(b.state, 'created'); assert.equal(fault.error.code, 'INTERNAL_ERROR');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: b.iframe.contentWindow, data: { bap: 'message', kind: 'event', name: 'component.fault' } }); assert.equal(b.state, 'created'); host.destroy();
});
