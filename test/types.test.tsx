// Compiled by `npm run typecheck`, never run.
import Pusher from 'pusher-js';
import { HibiraProvider, useAgentStream, useChannel, useEvent, usePresence, useStream, useTrigger, useConnectionState, hibiraOptions } from '@hibira-io/react';
import { streamToChannel } from '@hibira-io/react/server';

export function App() {
  return (
    <HibiraProvider appKey="key" options={{ channelAuthorization: { endpoint: '/auth', transport: 'ajax' } }}>
      <Chat />
    </HibiraProvider>
  );
}

function Chat() {
  const channel = useChannel('private-chat');
  useEvent<{ text: string }>(channel, 'message', (m) => m.text.toUpperCase());
  const { members, me } = usePresence<{ name: string }>('presence-room');
  const trigger = useTrigger('private-chat');
  trigger('client-typing', {});
  const { text, done, stream } = useStream<{ model: string }>('private-ai');
  const agent = useAgentStream('private-hibira-ai.user.1', { rewind: { seconds: 60 }, invocationId: 'inv' });
  const agentText: string = agent.text;
  const agentStatus: 'idle' | 'streaming' | 'awaiting_approval' | 'done' | 'error' = agent.status;
  const firstTool: string | null | undefined = agent.toolCalls[0]?.name;
  const state: 'connected' | string = useConnectionState();
  return (
    <p>
      {members.map((m) => m.info?.name).join()} {me?.id} {text} {String(done)} {stream?.meta?.model} {state}
    </p>
  );
}

const p = new Pusher('k', hibiraOptions({ wsHost: 'localhost' }));
export const echoProvider = <HibiraProvider client={p} />;

export async function server(pusher: { trigger(c: string, e: string, d: any, x?: any): Promise<any> }) {
  async function* gen() {
    yield 'a';
  }
  const r = await streamToChannel(pusher, 'private-ai', gen(), { meta: { model: 'm' }, interval: 50 });
  return r.id + r.text;
}
