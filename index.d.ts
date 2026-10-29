import type { ReactNode, ReactElement } from 'react';
import type Pusher from 'pusher-js';
import type { Options } from 'pusher-js';
import type { Member } from './client.js';
import type { Stream } from './stream.js';

export type { Member } from './client.js';
export type { Stream, StreamPayload, StreamStore } from './stream.js';
export { HIBIRA_DEFAULTS, hibiraOptions } from './client.js';
export { STREAM_EVENT, createStreamStore } from './stream.js';

/** A pusher-js channel (PresenceChannel and PrivateChannel included). */
export type Channel = ReturnType<Pusher['subscribe']>;
/** A channel name to subscribe to, a channel to use as is, or null for none. */
export type ChannelTarget = string | Channel | null | undefined;

export type ConnectionState = 'initialized' | 'connecting' | 'connected' | 'unavailable' | 'failed' | 'disconnected';

export interface HibiraProviderProps {
  /** App key from the Hibira portal. */
  appKey?: string;
  /** pusher-js options merged over HIBIRA_DEFAULTS. Read when the connection opens. */
  options?: Partial<Options>;
  /** Use this client instead of opening one, e.g. `echo.connector.pusher`. Not disconnected on unmount. */
  client?: Pusher | null;
  children?: ReactNode;
}

export function HibiraProvider(props: HibiraProviderProps): ReactElement;

/** The pusher-js client, or null before it opens (and on the server). */
export function usePusher(): Pusher | null;

/** Subscribes while mounted; components share one subscription per name. */
export function useChannel(name: string | null | undefined): Channel | null;

/** Calls handler for each event on the channel; returns the channel. */
export function useEvent<T = any>(
  target: ChannelTarget,
  event: string | null | undefined,
  handler: (data: T, metadata?: { user_id?: string }) => void,
): Channel | null;

export function useConnectionState(): ConnectionState;

export interface Presence<Info = any> {
  channel: Channel | null;
  /** You first. */
  members: Member<Info>[];
  others: Member<Info>[];
  me: Member<Info> | null;
  count: number;
}

export function usePresence<Info = any>(target: ChannelTarget): Presence<Info>;

/** Sends a client event ("client-..."); false when not subscribed yet. */
export function useTrigger(target: ChannelTarget): (event: `client-${string}`, data?: any) => boolean;

export interface UseStreamOptions {
  /** Default "ai-stream". */
  event?: string;
  /** Follow only this stream. */
  id?: string;
  /** Streams kept, default 50. */
  maxStreams?: number;
}

export interface StreamState<Meta = any> {
  channel: Channel | null;
  /** The stream with `id`, or else the one that started last. */
  stream: Stream<Meta> | null;
  streams: Record<string, Stream<Meta>>;
  text: string;
  done: boolean;
  error: string | null;
  /** Forget every stream. */
  reset(): void;
}

export function useStream<Meta = any>(target: ChannelTarget, options?: UseStreamOptions): StreamState<Meta>;
