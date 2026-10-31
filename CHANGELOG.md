# Changelog

## 0.2.0

- `useStream(channel, { rewind: true })` catches up from channel history
  (`pusher:rewind`) on every subscription, so a reload or a dropped
  connection in the middle of an answer no longer loses tokens. It returns
  the rewind's result as `history`. Needs channel history on for the app.
- `followStream(channel, { apply, event, rewind })`, the same for any
  pusher-js channel; `event` may list several event names.

## 0.1.1

The package homepage on npm now links to https://hibira.io. No code changes.

## 0.1.0

First release: `HibiraProvider`, `usePusher`, `useChannel` (shared,
reference-counted subscriptions), `useEvent`, `usePresence`, `useTrigger`,
`useConnectionState`, and LLM streaming with `streamToChannel()`
(`@hibira-io/react/server`) and `useStream()`.
