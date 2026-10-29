// React hooks for pusher-js on Hibira (and Laravel Echo, or any
// Pusher-compatible server): one connection for the app, channels shared
// between components, events, presence members, connection state, client
// events, and useStream() for LLM output sent with streamToChannel().
//
// The connection is opened in an effect, never during render, so server
// rendering (Next.js, Remix) does not connect and StrictMode's double mount
// does not leave a second socket behind. Until it opens, usePusher() returns
// null and the other hooks return their empty values.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Pusher from 'pusher-js';
import { acquireChannel, hibiraOptions, isClientEvent, presenceMembers, releaseChannel } from './client.js';
import { STREAM_EVENT, createStreamStore, latestStream } from './stream.js';

export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore } from './stream.js';

const HibiraContext = createContext(null);

/**
 * Opens one Hibira connection for the components inside it.
 *
 * @param {object} props
 * @param {string} [props.appKey] the app key from the Hibira portal
 * @param {object} [props.options] pusher-js options, merged over HIBIRA_DEFAULTS
 *   (channelAuthorization, userAuthentication, wsHost for a local server...)
 * @param {object} [props.client] an existing pusher-js client to use instead,
 *   e.g. `echo.connector.pusher`; it is not disconnected on unmount
 */
export function HibiraProvider({ appKey, options, client, children }) {
  const [own, setOwn] = useState(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (client || !appKey) return undefined;
    const pusher = new Pusher(appKey, hibiraOptions(optionsRef.current));
    setOwn(pusher);
    return () => {
      pusher.disconnect();
      setOwn(null);
    };
  }, [client, appKey]);

  return createElement(HibiraContext.Provider, { value: client ?? own }, children);
}

/** The pusher-js client, or null before it opens (and on the server). */
export function usePusher() {
  return useContext(HibiraContext);
}

/**
 * Subscribes to a channel while the component is mounted. Components that
 * use the same name share one subscription. Pass null to subscribe to nothing.
 * @returns the pusher-js channel, or null
 */
export function useChannel(name) {
  const pusher = usePusher();
  const [channel, setChannel] = useState(null);

  useEffect(() => {
    if (!pusher || !name) {
      setChannel(null);
      return undefined;
    }
    setChannel(acquireChannel(pusher, name));
    return () => releaseChannel(pusher, name);
  }, [pusher, name]);

  return channel && channel.name === name ? channel : null;
}

// A channel name subscribes; a channel object (Echo's .subscription, a
// channel from useChannel) is used as is.
function useTarget(target) {
  const named = target == null || typeof target === 'string';
  const channel = useChannel(named ? target : null);
  return named ? channel : target;
}

/**
 * Calls handler(data, metadata) for each `event` on a channel. The handler
 * may change on every render without rebinding.
 * @param {string|object|null} target channel name or pusher-js channel
 * @returns the channel, or null
 */
export function useEvent(target, event, handler) {
  const channel = useTarget(target);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!channel || !event) return undefined;
    const fn = (data, metadata) => handlerRef.current?.(data, metadata);
    channel.bind(event, fn);
    return () => channel.unbind(event, fn);
  }, [channel, event]);

  return channel;
}

/**
 * The connection state: "initialized", "connecting", "connected",
 * "unavailable", "failed" or "disconnected".
 */
export function useConnectionState() {
  const pusher = usePusher();
  const [state, setState] = useState(() => pusher?.connection.state ?? 'initialized');

  useEffect(() => {
    if (!pusher) {
      setState('initialized');
      return undefined;
    }
    setState(pusher.connection.state);
    const fn = ({ current }) => setState(current);
    pusher.connection.bind('state_change', fn);
    return () => pusher.connection.unbind('state_change', fn);
  }, [pusher]);

  return state;
}

const PRESENCE_EVENTS = ['pusher:subscription_succeeded', 'pusher:member_added', 'pusher:member_removed'];

/**
 * Members of a presence channel, kept up to date.
 * @param {string|object|null} target presence channel name or channel
 * @returns {{channel, members, others, me, count}} members are
 *   [{ id, info, me }] with you first; info is the user_info your auth signed
 */
export function usePresence(target) {
  const channel = useTarget(target);
  const [members, setMembers] = useState([]);

  useEffect(() => {
    if (!channel) {
      setMembers([]);
      return undefined;
    }
    const update = () => setMembers(presenceMembers(channel));
    update();
    for (const ev of PRESENCE_EVENTS) channel.bind(ev, update);
    return () => {
      for (const ev of PRESENCE_EVENTS) channel.unbind(ev, update);
    };
  }, [channel]);

  return useMemo(
    () => ({
      channel,
      members,
      others: members.filter((m) => !m.me),
      me: members.find((m) => m.me) ?? null,
      count: members.length,
    }),
    [channel, members],
  );
}

/**
 * A function that sends a client event on a private or presence channel:
 * `trigger('client-typing', { at: Date.now() })`. Returns false when the
 * channel is not subscribed yet. Turn on client events for the app first.
 */
export function useTrigger(target) {
  const channel = useTarget(target);
  return useCallback(
    (event, data) => {
      if (!isClientEvent(event)) throw new Error(`useTrigger: "${event}" must start with "client-"`);
      if (!channel || !channel.subscribed) return false;
      return channel.trigger(event, data ?? {});
    },
    [channel],
  );
}

/**
 * Text streamed to a channel with streamToChannel(), put back together.
 *
 * @param {string|object|null} target channel name or channel
 * @param {object} [options]
 * @param {string} [options.event="ai-stream"] event name
 * @param {string} [options.id] follow only this stream id
 * @param {number} [options.maxStreams=50] streams kept, oldest dropped first
 * @returns {{stream, streams, text, done, error, reset, channel}} `stream` is
 *   the one with `id`, or else the one that started last
 */
export function useStream(target, { event = STREAM_EVENT, id, maxStreams = 50 } = {}) {
  const [streams, setStreams] = useState({});
  const store = useMemo(() => createStreamStore((next) => setStreams(next), { maxStreams }), [maxStreams]);
  const channel = useEvent(target, event, (payload) => {
    if (id != null && String(payload?.id) !== String(id)) return;
    store.apply(payload);
  });

  const stream = id != null ? streams[String(id)] ?? null : latestStream(streams);
  return {
    channel,
    stream,
    streams,
    text: stream?.text ?? '',
    done: stream?.done ?? false,
    error: stream?.error ?? null,
    reset: store.reset,
  };
}
