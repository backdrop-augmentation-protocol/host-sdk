import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRuntime, isManifest } from '../dist/index.js';

class FakeWindow { listeners = new Map(); addEventListener(name, fn) { this.listeners.set(name, fn); } dispatch(event) { this.listeners.get(event.type)?.(event); } }
class FakeIframe { style = {}; attributes = new Map(); children = []; contentWindow = { messages: [], postMessage: (message, origin) => this.contentWindow.messages.push({ message, origin }) }; listeners = new Map(); setAttribute(name, value) { this.attributes.set(name, value); } addEventListener(name, fn) { this.listeners.set(name, fn); } appendChild(child) { this.children.push(child); } remove() { this.removed = true; for (const child of this.children) child.remove?.(); } load() { this.listeners.get('load')?.(); } }
class FakeDocument { baseURI = 'https://wallpaper.test/'; createElement() { return new FakeIframe(); } }
class Container { children = []; appendChild(child) { this.children.push(child); } }
const response = (correlationId, result, sessionId = 'session-1') => ({ protocol: { name: 'bap', version: '0.1.0', profile: 'core' }, kind: 'response', id: `response-${correlationId}`, correlationId, timestamp: new Date().toISOString(), sessionId, ok: true, result });
const event = (name, payload) => ({ protocol: { name: 'bap', version: '0.1.0', profile: 'core' }, kind: 'event', id: 'event-1', timestamp: new Date().toISOString(), event: name, payload });

test('reports a load timeout if a mounted iframe never navigates', async () => {
  const host = new HostRuntime({ window: new FakeWindow(), document: new FakeDocument(), handshakeTimeoutMs: 5 });
  let fault;
  host.on('componentFault', value => { fault = value; });
  const component = host.mount({ id: 'clock', src: 'https://component.test/clock.html', container: new Container() });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(component.state, 'failed');
  assert.equal(fault.error.code, 'TIMEOUT');
  host.destroy();
});

test('uses the Core Profile envelope and completes helloAck, initialize, and start', () => {
  const window = new FakeWindow(); const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  assert.equal(isManifest(host.manifest), true); assert.equal(host.manifest.role, 'host'); assert.deepEqual(host.manifest.configScopes, ['global', 'wallpaper']);
  const component = host.mount({ id: 'clock', src: 'https://component.test/clock.html', container: new Container(), allowedOrigin: 'https://component.test' }); component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  assert.equal(hello.kind, 'request'); assert.equal(hello.method, 'hello'); assert.equal(hello.protocol.profile, 'core'); assert.ok(hello.timestamp); assert.equal(hello.payload.role, 'host');
  assert.deepEqual(hello.payload.protocolVersions, ['0.1.0']); assert.equal(hello.payload.identity.id, host.manifest.id);
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: ['lifecycle'], permissions: [] }) });
  const initialize = component.iframe.contentWindow.messages.at(-1).message; assert.equal(initialize.method, 'initialize'); assert.equal(component.state, 'connected');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(initialize.id, { method: 'initialize' }) });
  const start = component.iframe.contentWindow.messages.at(-1).message; assert.equal(start.method, 'start');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(start.id, {}) });
  assert.equal(component.state, 'running'); assert.deepEqual(component.capabilities, ['lifecycle']); host.destroy();
});

test('runs two component sessions independently and isolates a later fault', () => {
  const window = new FakeWindow();
  const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const mounts = ['clock-left', 'clock-right'].map(instanceId => host.mount({ instanceId, componentId: 'org.example.clock', src: `https://component.test/${instanceId}.html`, container: new Container() }));
  for (const component of mounts) component.iframe.load();
  const answer = (component, request, result, session) => window.dispatch({
    type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow,
    data: response(request.id, result, session)
  });
  for (const [index, component] of mounts.entries()) {
    const session = `session-${index + 1}`;
    const hello = component.iframe.contentWindow.messages.at(-1).message;
    answer(component, hello, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [] }, session);
    const initialize = component.iframe.contentWindow.messages.at(-1).message;
    assert.equal(initialize.method, 'initialize');
    answer(component, initialize, {}, session);
    const start = component.iframe.contentWindow.messages.at(-1).message;
    assert.equal(start.method, 'start');
    answer(component, start, {}, session);
  }
  assert.deepEqual(mounts.map(component => component.state), ['running', 'running']);
  window.dispatch({ type: 'message', origin: 'https://component.test', source: mounts[0].iframe.contentWindow,
    data: { ...event('component.fault', { message: 'clock failed' }), sessionId: 'session-1' } });
  assert.deepEqual(mounts.map(component => component.state), ['failed', 'running']);
  host.destroy();
});

test('distinguishes repeated component packages by stable instance ID and negotiates only offered extensions', () => {
  const window = new FakeWindow();
  const extension = { id: 'org.bap.composition', versions: ['0.1.0'] };
  const host = new HostRuntime({ window, document: new FakeDocument(), extensions: [extension] });
  const a = host.mount({ instanceId: 'clock-a', componentId: 'org.example.clock', srcdoc: '<p>A</p>', container: new Container() });
  const b = host.mount({ instanceId: 'clock-b', componentId: 'org.example.clock', srcdoc: '<p>B</p>', container: new Container() });
  assert.notEqual(a, b);
  assert.equal(host.get('clock-a'), a);
  assert.equal(host.get('clock-b'), b);
  assert.throws(() => host.mount({ instanceId: 'clock-a', componentId: 'org.example.clock', srcdoc: '<p>duplicate</p>', container: new Container() }), /already mounted/);

  a.iframe.load();
  const hello = a.iframe.contentWindow.messages[0].message;
  assert.deepEqual(hello.payload.extensions, [extension]);
  assert.equal(hello.payload.instanceId, 'clock-a');
  const acknowledgement = response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [], selectedExtensions: [extension] });
  acknowledgement.result.selectedExtensions = [{ id: 'org.bap.unoffered', version: '0.1.0' }];
  window.dispatch({ type: 'message', origin: 'null', source: a.iframe.contentWindow, data: acknowledgement });
  assert.equal(a.state, 'failed');
  assert.equal(b.state, 'created');
  host.destroy();
});

test('unmounts one component immediately so a preset can replace it', () => {
  const host = new HostRuntime({ window: new FakeWindow(), document: new FakeDocument() });
  const a = host.mount({ id: 'clock', srcdoc: '<title>Clock</title>', container: new Container() });
  const b = host.mount({ id: 'calendar', srcdoc: '<title>Calendar</title>', container: new Container() });
  host.unmount('clock');
  assert.equal(a.state, 'stopped');
  assert.equal(a.iframe.removed, true);
  assert.equal(host.get('clock'), undefined);
  assert.equal(host.get('calendar'), b);
  const replacement = host.mount({ id: 'clock', srcdoc: '<title>Replacement</title>', container: new Container() });
  assert.notEqual(replacement, a);
  host.destroy();
  assert.equal(replacement.iframe.removed, true);
  assert.equal(b.iframe.removed, true);
});

test('uses lifecycle requests for pause/resume/stop and propagates size events', () => {
  const window = new FakeWindow(); const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const component = host.mount({ id: 'a', src: 'https://component.test/a', container: new Container() }); component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
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

test('accepts CEF file origins only for file-backed component frames', () => {
  const window = new FakeWindow();
  const document = new FakeDocument(); document.baseURI = 'file:///D:/wallpaper/index.html';
  const host = new HostRuntime({ window, document });
  const component = host.mount({ id: 'clock', src: './clock.html', container: new Container() });
  assert.equal(component.acceptsOrigin('null'), true);
  assert.equal(component.acceptsOrigin('file://'), true);
  assert.equal(component.acceptsOrigin(''), true);
  assert.equal(component.acceptsOrigin('https://evil.test'), false);
  component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  window.dispatch({ type: 'message', origin: 'file://', source: component.iframe.contentWindow, data: response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
  assert.equal(component.iframe.contentWindow.messages.at(-1).message.method, 'initialize');
  host.destroy();
});

test('accepts opaque CEF event origin when URL reports file://', () => {
  const window = new FakeWindow();
  const document = new FakeDocument(); document.baseURI = 'file:///D:/wallpaper/index.html';
  const host = new HostRuntime({ window, document });
  const component = host.mount({ id: 'clock', src: './clock.html', container: new Container(), allowedOrigin: 'file://' });
  assert.equal(component.acceptsOrigin('null'), true);
  assert.equal(component.acceptsOrigin('https://evil.test'), false);
  component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0].message;
  window.dispatch({ type: 'message', origin: 'null', source: component.iframe.contentWindow, data: response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
  assert.equal(component.iframe.contentWindow.messages.at(-1).message.method, 'initialize');
  host.destroy();
});

test('mounts inline HTML with an opaque origin and only script sandbox permission', () => {
  const window = new FakeWindow();
  const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const html = '<!doctype html><title>Clock</title>';
  const component = host.mount({ id: 'clock', srcdoc: html, container: new Container() });
  assert.equal(component.iframe.srcdoc, html);
  assert.equal(component.iframe.attributes.get('sandbox'), 'allow-scripts');
  assert.equal(component.acceptsOrigin('null'), true);
  assert.equal(component.acceptsOrigin('https://component.test'), false);
  component.iframe.load();
  const hello = component.iframe.contentWindow.messages[0];
  assert.equal(hello.origin, '*');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.message.id, { selectedProtocol: hello.message.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
  assert.equal(component.state, 'connected');
  window.dispatch({ type: 'message', origin: 'null', source: component.iframe.contentWindow, data: response(hello.message.id, { selectedProtocol: hello.message.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
  assert.equal(component.iframe.contentWindow.messages.at(-1).message.method, 'initialize');
  host.destroy();
});

test('rejects ambiguous or non-isolated inline component sources', () => {
  const host = new HostRuntime({ window: new FakeWindow(), document: new FakeDocument() });
  const container = new Container();
  assert.throws(() => host.mount({ id: 'clock', container }), /Exactly one/);
  assert.throws(() => host.mount({ id: 'clock', src: 'clock.html', srcdoc: '<p>clock</p>', container }), /Exactly one/);
  assert.throws(() => host.mount({ id: 'clock', srcdoc: '', container }), /non-empty/);
  assert.throws(() => host.mount({ id: 'clock', srcdoc: '<p>clock</p>', allowedOrigin: '*', container }), /opaque origin/);
  host.destroy();
});

test('applies manual layout to a stable wrapper without re-creating the iframe on viewport changes', () => {
  const host = new HostRuntime({ window: new FakeWindow(), document: new FakeDocument(), viewport: { width: 1000, height: 500 } });
  const container = new Container();
  const layout = { mode: 'manual', anchor: 'top-left', x: 0.12, y: 0.08, width: 0.2, height: 0.12, scale: 1.2, rotation: 15, opacity: 0.8, zIndex: 10, locked: false };
  const component = host.mount({ instanceId: 'clock', componentId: 'org.example.clock', srcdoc: '<p>clock</p>', container, layout });
  const iframe = component.iframe;
  assert.equal(container.children.length, 1);
  assert.equal(component.wrapper.style.left, '120px');
  assert.equal(component.wrapper.style.top, '40px');
  assert.equal(component.wrapper.style.width, '200px');
  assert.equal(component.wrapper.style.height, '60px');
  assert.equal(component.wrapper.style.transformOrigin, '0% 0%');
  host.setViewport({ width: 2000, height: 1000 });
  assert.equal(component.iframe, iframe);
  assert.equal(component.wrapper.style.width, '400px');
  assert.equal(component.wrapper.style.height, '120px');
  assert.equal(container.children.length, 1);
  host.destroy();
});

test('resolves automatic grid cells deterministically and honors locked manual instances', () => {
  const host = new HostRuntime({ window: new FakeWindow(), document: new FakeDocument(), viewport: { width: 1000, height: 500 } });
  host.setLayoutMode('grid', { columns: 2, gapX: 0.1, gapY: 0.05, paddingX: 0.1, paddingY: 0.1 });
  const container = new Container();
  const automatic = order => ({ mode: 'automatic', order, scale: 1, rotation: 0, opacity: 1, zIndex: order, locked: false });
  const a = host.mount({ instanceId: 'b', componentId: 'org.example.clock', srcdoc: '<p>b</p>', container, layout: automatic(1) });
  const b = host.mount({ instanceId: 'a', componentId: 'org.example.clock', srcdoc: '<p>a</p>', container, layout: automatic(0) });
  const pinned = host.mount({ instanceId: 'pinned', componentId: 'org.example.calendar', srcdoc: '<p>pinned</p>', container, layout: { mode: 'manual', anchor: 'center', x: 0.5, y: 0.5, width: 0.2, height: 0.2, scale: 1, rotation: 0, opacity: 1, zIndex: 5, locked: true } });
  assert.equal(b.wrapper.style.left, '100px');
  assert.equal(b.wrapper.style.width, '350px');
  assert.equal(a.wrapper.style.left, '550px');
  assert.equal(a.wrapper.style.width, '350px');
  assert.equal(pinned.wrapper.style.left, '500px');
  assert.equal(pinned.wrapper.style.transformOrigin, '50% 50%');
  host.destroy();
});

test('keeps presentation visibility separate from lifecycle and disables hit testing while hidden', () => {
  const window = new FakeWindow();
  const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test' });
  const component = host.mount({ instanceId: 'clock', componentId: 'org.example.clock', src: 'https://component.test/clock.html', allowedOrigin: 'https://component.test', container: new Container(), presentation: { userVisible: false } });
  component.iframe.load();
  const hello = component.iframe.contentWindow.messages.at(-1).message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [] }, 's') });
  let initialize = component.iframe.contentWindow.messages.at(-1).message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(initialize.id, {}, 's') });
  let start = component.iframe.contentWindow.messages.at(-1).message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(start.id, {}, 's') });
  assert.equal(component.state, 'running');
  assert.equal(component.wrapper.style.visibility, 'hidden');
  assert.equal(component.wrapper.style.pointerEvents, 'none');
  component.setPresentation({ userVisible: true });
  assert.equal(component.wrapper.style.visibility, 'visible');
  component.setPresentation({ sceneAllowed: false });
  assert.equal(component.state, 'running');
  assert.equal(component.wrapper.style.visibility, 'hidden');
  host.destroy();
});

test('accepts an exactly offered presentation extension and reports initial effective visibility', () => {
  const window = new FakeWindow();
  const host = new HostRuntime({ window, document: new FakeDocument(), targetOrigin: 'https://component.test', extensions: [{ id: 'org.bap.presentation', versions: ['0.1.0'] }] });
  const component = host.mount({ instanceId: 'clock', componentId: 'org.example.clock', src: 'https://component.test/clock.html', allowedOrigin: 'https://component.test', container: new Container(), presentation: { userVisible: false } });
  component.iframe.load();
  const hello = component.iframe.contentWindow.messages.at(-1).message;
  const ack = response(hello.id, { selectedProtocol: hello.protocol, role: 'component', capabilities: [], permissions: [], selectedExtensions: [{ id: 'org.bap.presentation', version: '0.1.0' }] }, 's');
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: ack });
  let lifecycle = component.iframe.contentWindow.messages.at(-1).message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(lifecycle.id, {}, 's') });
  lifecycle = component.iframe.contentWindow.messages.at(-1).message;
  window.dispatch({ type: 'message', origin: 'https://component.test', source: component.iframe.contentWindow, data: response(lifecycle.id, {}, 's') });
  assert.equal(component.state, 'running');
  const visibility = component.iframe.contentWindow.messages.map(entry => entry.message).find(message => message.event === 'presentation.visibility.changed');
  assert.equal(visibility.payload.instanceId, 'clock');
  assert.equal(visibility.payload.visible, false);
  host.destroy();
});
