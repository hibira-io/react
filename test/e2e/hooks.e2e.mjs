// End-to-end test against a running Hibira (or any Pusher-compatible) server
// with client events enabled. Skipped unless HIBIRA_E2E_KEY is set:
//
//   HIBIRA_E2E_HOST=127.0.0.1 HIBIRA_E2E_PORT=8080 HIBIRA_E2E_TLS=0 \
//   HIBIRA_E2E_APP_ID=... HIBIRA_E2E_KEY=... HIBIRA_E2E_SECRET=... npm run test:e2e
import '../dom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { createRequire } from 'node:module';
import PusherServer from 'pusher';
import { HibiraProvider, useConnectionState, useEvent, usePresence, usePusher, useStream, useTrigger } from '../../index.js';
import { streamToChannel } from '../../server.js';

const require = createRequire(import.meta.url);
const { createRoot } = require('react-dom/client');
const h = React.createElement;
const act = React.act;

const env = process.env;
const skip = !env.HIBIRA_E2E_KEY && 'set HIBIRA_E2E_KEY to run';
const host = env.HIBIRA_E2E_HOST ?? '127.0.0.1';
const port = Number(env.HIBIRA_E2E_PORT ?? 8080);
const tls = env.HIBIRA_E2E_TLS === '1';

const server = skip
  ? null
  : new PusherServer({ appId: env.HIBIRA_E2E_APP_ID, key: env.HIBIRA_E2E_KEY, secret: env.HIBIRA_E2E_SECRET, host, port: String(port), useTLS: tls });

const options = (userId, name) => ({
  wsHost: host,
  wsPort: port,
  wssPort: port,
  forceTLS: tls,
  enabledTransports: ['ws'],
  channelAuthorization: {
    customHandler: ({ socketId, channelName }, cb) => {
      try {
        const user = channelName.startsWith('presence-') ? { user_id: userId, user_info: { name } } : undefined;
        cb(null, server.authorizeChannel(socketId, channelName, user));
      } catch (err) {
        cb(err, null);
      }
    },
  },
});

async function waitFor(check, what) {
  const until = Date.now() + 5000;
  for (;;) {
    try {
      const v = check();
      if (v) return v;
    } catch {}
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await act(() => new Promise((r) => setTimeout(r, 25)));
  }
}

test('hooks on a real server: presence, client events, streamed text', { skip }, async () => {
  const room = `presence-e2e-${Date.now()}`;
  const ai = `private-ai-${Date.now()}`;
  const views = {};
  const typing = [];

  function View({ who }) {
    const state = useConnectionState();
    const presence = usePresence(room);
    const trigger = useTrigger(room);
    useEvent(room, 'client-typing', (data, meta) => typing.push([who, data, meta?.user_id]));
    const stream = useStream(ai);
    views[who] = { state, presence, trigger, stream };
    return null;
  }

  const roots = [];
  for (const [id, name] of [
    ['alice', 'Alice'],
    ['bob', 'Bob'],
  ]) {
    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => root.render(h(HibiraProvider, { appKey: env.HIBIRA_E2E_KEY, options: options(id, name) }, h(View, { who: id }))));
  }
  try {
    await waitFor(() => views.alice.state === 'connected' && views.bob.state === 'connected', 'connected');
    await waitFor(() => views.alice.presence.count === 2 && views.bob.presence.count === 2, 'both members');
    assert.equal(views.alice.presence.me.id, 'alice');
    assert.deepEqual(views.alice.presence.others.map((m) => m.info.name), ['Bob']);

    assert.equal(views.alice.trigger('client-typing', { on: true }), true);
    await waitFor(() => typing.length === 1, 'client event');
    assert.deepEqual(typing[0], ['bob', { on: true }, 'alice']);

    // An LLM-like stream: 200 tokens, a few ms apart, with non-ASCII text.
    async function* llm() {
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 2));
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: `トークン${i} ` } };
      }
    }
    const res = await streamToChannel(server, ai, llm(), { meta: { model: 'test' }, interval: 50 });
    assert.ok(res.events < 30, `${res.events} events for 200 tokens`);
    await waitFor(() => views.bob.stream.done && views.alice.stream.done, 'stream done');
    for (const who of ['alice', 'bob']) {
      assert.equal(views[who].stream.text, res.text);
      assert.deepEqual(views[who].stream.stream.meta, { model: 'test' });
      assert.equal(views[who].stream.stream.incomplete, false);
    }

    // Bob leaves; Alice sees it.
    await act(async () => roots[1].unmount());
    await waitFor(() => views.alice.presence.count === 1, 'bob left');
  } finally {
    for (const root of roots) await act(async () => root.unmount());
  }
});

// Needs channel history on for the app (history: true, history_seconds > 0).
test('useStream rewind: a reload mid-answer gets the whole answer', { skip: skip || (!env.HIBIRA_E2E_HISTORY && 'set HIBIRA_E2E_HISTORY=1 (app with channel history)') }, async () => {
  const ai = `private-ai-rewind-${Date.now()}`;
  const tokens = Array.from({ length: 120 }, (_, i) => `t${i} `);
  let release;
  const gate = new Promise((r) => (release = r));
  async function* llm() {
    for (let i = 0; i < tokens.length; i++) {
      if (i === 60) await gate; // half the answer is out before the page loads
      yield tokens[i];
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  const sending = streamToChannel(server, ai, llm(), { interval: 20 });
  await new Promise((r) => setTimeout(r, 400));

  const views = {};
  function View() {
    views.plain = useStream(ai);
    return null;
  }
  function Rewound() {
    views.rewound = useStream(ai, { rewind: { seconds: 60 } });
    return null;
  }
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () =>
    root.render(h(HibiraProvider, { appKey: env.HIBIRA_E2E_KEY, options: options('u', 'U') }, h(View), h(Rewound))),
  );
  await waitFor(() => views.rewound.history, 'rewind answer');
  assert.equal(views.rewound.history.error, undefined, views.rewound.history.error);
  assert.ok(views.rewound.history.count > 0);
  // Before the final event (whose text could patch things up) the first half is already there.
  const firstHalf = tokens.slice(0, 60).join('');
  await waitFor(() => views.rewound.text.length >= firstHalf.length, 'first half');
  assert.equal(views.rewound.text.slice(0, firstHalf.length), firstHalf);
  assert.equal(views.rewound.done, false);
  release();
  const res = await sending;
  await waitFor(() => views.rewound.done && views.plain.done, 'stream done');
  assert.equal(views.rewound.text, res.text);
  assert.equal(views.rewound.stream.incomplete, false);
  await act(async () => root.unmount());
});

test('useStream rewind: chunks sent while disconnected are caught up', { skip: skip || (!env.HIBIRA_E2E_HISTORY && 'set HIBIRA_E2E_HISTORY=1 (app with channel history)') }, async () => {
  const ai = `private-ai-reconnect-${Date.now()}`;
  const views = {};
  function View() {
    views.pusher = usePusher();
    views.state = useConnectionState();
    views.s = useStream(ai, { rewind: true });
    return null;
  }
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => root.render(h(HibiraProvider, { appKey: env.HIBIRA_E2E_KEY, options: options('u', 'U') }, h(View))));
  await waitFor(() => views.s.history, 'first rewind');

  const parts = Array.from({ length: 90 }, (_, i) => `p${i} `);
  const gates = [];
  const gate = (n) => new Promise((r) => (gates[n] = r));
  const waits = [gate(0), gate(1)];
  async function* llm() {
    for (let i = 0; i < parts.length; i++) {
      if (i === 30) await waits[0];
      if (i === 60) await waits[1];
      yield parts[i];
    }
  }
  const sending = streamToChannel(server, ai, llm(), { interval: 10 });
  await waitFor(() => views.s.text.length >= parts.slice(0, 30).join('').length, 'first third');
  await act(async () => views.pusher.disconnect());
  await waitFor(() => views.state === 'disconnected', 'disconnected');
  gates[0]();
  await new Promise((r) => setTimeout(r, 500)); // the middle third goes out while offline
  await act(async () => views.pusher.connect());
  const middle = parts.slice(0, 60).join('');
  await waitFor(() => views.s.text.length >= middle.length, 'middle third after reconnect');
  assert.equal(views.s.text.slice(0, middle.length), middle);
  assert.equal(views.s.done, false);
  gates[1]();
  const res = await sending;
  await waitFor(() => views.s.done, 'done');
  assert.equal(views.s.text, res.text);
  await act(async () => root.unmount());
});
