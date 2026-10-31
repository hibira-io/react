import './dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRequire } from 'node:module';
import {
  HibiraProvider,
  useChannel,
  useConnectionState,
  useEvent,
  usePresence,
  usePusher,
  useAgentStream,
  useStream,
  useTrigger,
} from '../index.js';
import { fakePusher } from './fake-pusher.mjs';

const { StrictMode, createElement: h, useState } = React;

// React 18.3+ exports act from react; 17 has it in react-dom/test-utils, no
// createRoot and no exports map (hence require).
const require = createRequire(import.meta.url);
const { renderToString } = require('react-dom/server');
const act = React.act ?? require('react-dom/test-utils').act;
let createRoot;
try {
  createRoot = require('react-dom/client').createRoot;
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  createRoot = (el) => ({ render: (ui) => ReactDOM.render(ui, el), unmount: () => ReactDOM.unmountComponentAtNode(el) });
}

// Renders `ui` and gives back the latest value each probe reported.
async function render(ui) {
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => root.render(ui));
  return {
    rerender: (next) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

function probe(hook, out) {
  return function Probe(props) {
    out.value = hook(props);
    return null;
  };
}

test('useChannel shares one subscription and leaves with the last user', async () => {
  const pusher = fakePusher();
  const a = {};
  const b = {};
  const A = probe(() => useChannel('private-a'), a);
  const B = probe(() => useChannel('private-a'), b);
  function App({ showA, showB }) {
    return h(HibiraProvider, { client: pusher }, showA && h(A), showB && h(B));
  }
  const r = await render(h(App, { showA: true, showB: true }));
  assert.equal(a.value, pusher.channel('private-a'));
  assert.equal(a.value, b.value);
  assert.equal(pusher.log.filter(([op]) => op === 'subscribe').length, 1);
  await r.rerender(h(App, { showA: false, showB: true }));
  assert.ok(pusher.channel('private-a'), 'still subscribed for B');
  await r.rerender(h(App, { showA: false, showB: false }));
  assert.equal(pusher.channel('private-a'), undefined);
  assert.deepEqual(pusher.log.at(-1), ['unsubscribe', 'private-a']);
  await r.unmount();
  assert.ok(!pusher.log.some(([op]) => op === 'disconnect'), 'a passed-in client is not disconnected');
});

test('useChannel follows name changes and null', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(({ name }) => useChannel(name), out);
  const r = await render(h(HibiraProvider, { client: pusher }, h(P, { name: 'x' })));
  assert.equal(out.value.name, 'x');
  await r.rerender(h(HibiraProvider, { client: pusher }, h(P, { name: 'y' })));
  assert.equal(out.value.name, 'y');
  assert.equal(pusher.channel('x'), undefined);
  await r.rerender(h(HibiraProvider, { client: pusher }, h(P, { name: null })));
  assert.equal(out.value, null);
  assert.equal(pusher.channels.size, 0);
});

test('useEvent calls the latest handler and unbinds on unmount', async () => {
  const pusher = fakePusher();
  const got = [];
  function C({ tag }) {
    useEvent('orders', 'created', (data, meta) => got.push([tag, data, meta]));
    return null;
  }
  const r = await render(h(HibiraProvider, { client: pusher }, h(C, { tag: 1 })));
  const ch = pusher.channel('orders');
  ch.emit('created', { id: 7 }, { user_id: 'u' });
  await r.rerender(h(HibiraProvider, { client: pusher }, h(C, { tag: 2 })));
  ch.emit('created', { id: 8 });
  assert.deepEqual(got, [
    [1, { id: 7 }, { user_id: 'u' }],
    [2, { id: 8 }, undefined],
  ]);
  assert.equal(ch.count('created'), 1, 'no rebinding on rerender');
  await r.unmount();
  assert.equal(ch.count('created'), 0);
});

test('useEvent takes a channel object too (Echo subscription)', async () => {
  const pusher = fakePusher();
  const ch = pusher.subscribe('private-echo');
  const got = [];
  function C() {
    useEvent(ch, 'ping', (d) => got.push(d));
    return null;
  }
  const r = await render(h(HibiraProvider, { client: pusher }, h(C)));
  ch.emit('ping', 1);
  assert.deepEqual(got, [1]);
  await r.unmount();
  assert.ok(pusher.channel('private-echo'), 'a channel you pass in is not unsubscribed');
});

test('useConnectionState', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(useConnectionState, out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.equal(out.value, 'connecting');
  await act(async () => pusher.setState('connected'));
  assert.equal(out.value, 'connected');
  await act(async () => pusher.setState('unavailable'));
  assert.equal(out.value, 'unavailable');
});

test('usePresence tracks members, you first', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => usePresence('presence-room'), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.deepEqual(out.value.members, []);
  await act(async () => pusher.succeed('presence-room', { a: { name: 'A' }, b: { name: 'B' } }, 'b'));
  assert.deepEqual(out.value.members, [
    { id: 'b', info: { name: 'B' }, me: true },
    { id: 'a', info: { name: 'A' }, me: false },
  ]);
  assert.equal(out.value.me.id, 'b');
  assert.equal(out.value.count, 2);
  await act(async () => pusher.join('presence-room', 'c', { name: 'C' }));
  assert.deepEqual(out.value.others.map((m) => m.id), ['a', 'c']);
  await act(async () => pusher.leave('presence-room', 'a'));
  assert.equal(out.value.count, 2);
});

test('usePresence on a channel another component already subscribed', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => usePresence('presence-room'), out);
  const Other = probe(() => useChannel('presence-room'), {});
  const r = await render(h(HibiraProvider, { client: pusher }, h(Other)));
  await act(async () => pusher.succeed('presence-room', { a: {} }, 'a'));
  await r.rerender(h(HibiraProvider, { client: pusher }, h(Other), h(P)));
  assert.equal(out.value.count, 1);
});

test('useTrigger sends client events once subscribed', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => useTrigger('private-chat'), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.equal(out.value('client-typing', { a: 1 }), false);
  await act(async () => pusher.succeed('private-chat'));
  assert.equal(out.value('client-typing', { a: 1 }), true);
  assert.equal(out.value('client-typing'), true);
  assert.deepEqual(pusher.channel('private-chat').sent, [
    ['client-typing', { a: 1 }],
    ['client-typing', {}],
  ]);
  assert.throws(() => out.value('typing'), /must start with "client-"/);
});

test('useStream puts a stream back together', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => useStream('private-ai'), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.equal(out.value.text, '');
  assert.equal(out.value.stream, null);
  const ch = pusher.channel('private-ai');
  await act(async () => {
    ch.emit('ai-stream', { id: 's1', seq: 0, delta: 'Hel', meta: { model: 'm' } });
    ch.emit('ai-stream', { id: 's1', seq: 1, delta: 'lo' });
  });
  assert.equal(out.value.text, 'Hello');
  assert.equal(out.value.done, false);
  assert.deepEqual(out.value.stream.meta, { model: 'm' });
  await act(async () => ch.emit('ai-stream', { id: 's1', seq: 2, done: true, text: 'Hello' }));
  assert.equal(out.value.done, true);
  await act(async () => ch.emit('ai-stream', { id: 's2', seq: 0, delta: 'Next' }));
  assert.equal(out.value.text, 'Next', 'the latest stream');
  assert.equal(Object.keys(out.value.streams).length, 2);
  await act(async () => out.value.reset());
  assert.equal(out.value.stream, null);
});

test('useStream with rewind catches up after subscribing', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => useStream('private-ai', { rewind: { seconds: 120 } }), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.equal(out.value.history, null);
  await act(async () => {
    pusher.succeed('private-ai');
  });
  const ch = pusher.channel('private-ai');
  assert.deepEqual(pusher.log.at(-1), ['send_event', 'pusher:rewind', { channel: 'private-ai', seconds: 120 }, 'private-ai']);
  await act(async () => {
    ch.emit('ai-stream', { id: 's1', seq: 1, delta: 'lo' });
    ch.emit('ai-stream', { id: 's1', seq: 0, delta: 'Hel' });
  });
  assert.equal(out.value.text, '', 'held until the history answers');
  await act(async () => ch.emit('pusher:rewind_succeeded', { count: 1, window: 3600, complete: true }));
  assert.equal(out.value.text, 'Hello');
  assert.equal(out.value.stream.incomplete, false);
  assert.deepEqual(out.value.history, { count: 1, window: 3600, complete: true });
});

test('useAgentStream follows Laravel AI events, chunks and rewind', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => useAgentStream('private-hibira-ai.user.1', { rewind: true }), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  assert.equal(out.value.status, 'idle');
  await act(async () => {
    pusher.succeed('private-hibira-ai.user.1');
  });
  const ch = pusher.channel('private-hibira-ai.user.1');
  assert.equal(pusher.log.at(-1)[1], 'pusher:rewind');
  const e = (id, type, fields) => ({ id, invocation_id: 'inv', type, ...fields });
  await act(async () => {
    ch.emit('stream_start', e('1', 'stream_start', { model: 'm' }));
    ch.emit('text_delta', e('2', 'text_delta', { delta: 'Hi' }));
    ch.emit('pusher:rewind_succeeded', { count: 1, window: 600, complete: true });
    ch.emit('text_delta', e('2', 'text_delta', { delta: 'Hi' }));
  });
  assert.equal(out.value.text, 'Hi');
  assert.equal(out.value.status, 'streaming');
  const json = JSON.stringify(e('3', 'tool_result', { tool_id: 't', result: 'x'.repeat(300), successful: true }));
  await act(async () => {
    ch.emit('hibira:chunk', { id: 'c', event: 'tool_result', index: 1, count: 2, data: json.slice(150) });
    ch.emit('hibira:chunk', { id: 'c', event: 'tool_result', index: 0, count: 2, data: json.slice(0, 150) });
    ch.emit('stream_end', e('4', 'stream_end', { reason: 'stop' }));
  });
  assert.equal(out.value.toolCalls[0].result, 'x'.repeat(300));
  assert.equal(out.value.done, true);
  assert.equal(out.value.run.id, 'inv');
});

test('useStream with an id and a custom event', async () => {
  const pusher = fakePusher();
  const out = {};
  const P = probe(() => useStream('private-ai', { id: 'mine', event: 'answer' }), out);
  await render(h(HibiraProvider, { client: pusher }, h(P)));
  const ch = pusher.channel('private-ai');
  await act(async () => {
    ch.emit('answer', { id: 'other', seq: 0, delta: 'no' });
    ch.emit('ai-stream', { id: 'mine', seq: 0, delta: 'no' });
    ch.emit('answer', { id: 'mine', seq: 0, delta: 'yes' });
  });
  assert.equal(out.value.text, 'yes');
  assert.deepEqual(Object.keys(out.value.streams), ['mine']);
});

test('HibiraProvider opens a pusher-js connection in an effect and closes it on unmount', async () => {
  const out = {};
  const P = probe(usePusher, out);
  const ui = h(
    StrictMode,
    null,
    h(HibiraProvider, { appKey: 'key', options: { wsHost: '127.0.0.1', wsPort: 9, forceTLS: false, enabledTransports: ['ws'] } }, h(P)),
  );
  // Nothing connects while rendering on the server.
  assert.equal(renderToString(ui), '');
  const r = await render(ui);
  const pusher = out.value;
  assert.ok(pusher, 'client opened');
  assert.equal(pusher.key, 'key');
  assert.equal(pusher.config.wsHost, '127.0.0.1');
  assert.equal(pusher.config.cluster, 'hkg');
  await r.unmount();
  assert.equal(pusher.connection.state, 'disconnected');
});

test('hooks without a provider or before it opens return empty values', async () => {
  const out = {};
  const P = probe(
    () => ({
      pusher: usePusher(),
      channel: useChannel('x'),
      state: useConnectionState(),
      presence: usePresence('presence-x'),
      stream: useStream('x'),
      trigger: useTrigger('private-x'),
    }),
    out,
  );
  await render(h(P));
  assert.equal(out.value.pusher, null);
  assert.equal(out.value.channel, null);
  assert.equal(out.value.state, 'initialized');
  assert.equal(out.value.presence.count, 0);
  assert.equal(out.value.stream.text, '');
  assert.equal(out.value.trigger('client-x'), false);
});

test('a provider switched to another client resubscribes', async () => {
  const p1 = fakePusher();
  const p2 = fakePusher();
  const out = {};
  const P = probe(() => useChannel('c'), out);
  function App() {
    const [client, setClient] = useState(p1);
    out.swap = () => setClient(p2);
    return h(HibiraProvider, { client }, h(P));
  }
  await render(h(App));
  assert.equal(out.value, p1.channel('c'));
  await act(async () => out.swap());
  assert.equal(out.value, p2.channel('c'));
  assert.equal(p1.channel('c'), undefined);
});
