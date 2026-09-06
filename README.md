# ChitChak

A voice-first chat platform — servers, channels, live audio — as a desktop app.

Discord and TeamSpeak in shape: a rail of servers, text and voice channels, and a
persistent bottom bar with mute, deafen and disconnect. Audio goes through a real
SFU, so bandwidth per person is constant no matter how many people are in a call.

## Architecture

```
  Electron renderer (React)
        │            │
   REST + WebSocket  │  WebRTC (Opus audio)
        │            │
   API server ──────►│      LiveKit SFU
   (Fastify)   mints │      (media only)
        │      tokens│
   Postgres + Redis
```

Three decisions worth knowing about:

**An SFU, not a peer-to-peer mesh.** In a mesh, each person uploads a copy of
their audio to every other person: six people in a channel means five upstreams
each, and home connections fall over. With an SFU every client publishes one
stream and subscribes to the rest, so upstream cost is flat. LiveKit is the SFU;
everything above it — identity, permissions, channels, presence — is ours.

**Media never touches the API server.** The server's role in a call is to decide
who is allowed in and mint a token scoped to exactly one room. A modified client
can claim anything it likes over the gateway and still cannot get audio out of a
server it has not joined.

**One WebSocket carries all realtime state.** Presence, voice state and messages
are a single event stream, and the client is a pure function of one snapshot plus
the events after it. Reconnecting means fetching a fresh snapshot, not replaying
a gap — there is no catch-up protocol to get subtly wrong.

## Running it

Prerequisites: Node 20+, Docker.

```bash
cp .env.example .env
npm install
npm run setup      # builds shared types, starts containers, migrates, seeds
npm run dev        # API server + desktop app
```

The seed creates two accounts so you can test a call with yourself:

| Email               | Password         |
| ------------------- | ---------------- |
| alice@example.com   | devpassword123   |
| bob@example.com     | devpassword123   |

Sign in as one in the app, and as the other in a second window
(`npm run dev:desktop` again) to hear yourself in a channel.

Individual pieces:

```bash
npm run infra:up / infra:down / infra:logs
npm run dev:server
npm run dev:desktop
npm run db:generate     # after editing src/db/schema.ts
npm run db:migrate
npm run typecheck
```

Ports: API `4000`, renderer `5173`, Postgres `5433`, Redis `6380`, SFU `7880`
(signalling), `7881` TCP / `7882` UDP (media).

## Layout

```
packages/protocol   Wire types shared by client and server. The contract.
apps/server         Fastify API + WebSocket gateway
  db/               Drizzle schema and migrations
  gateway/          Sessions, event fan-out, presence
  voice/            SFU tokens, room lifecycle, join/leave rules
  http/             REST routes
apps/desktop        Electron + React
  electron/         Main process and preload bridge
  src/lib/          api (REST), gateway (WebSocket), voice (WebRTC)
  src/store/        Single Zustand store; server events patch it
apps/site           chitchak.com: the landing page, and the host for /app
infra/livekit.yaml  SFU config
```

`src/` is the client, not the desktop client. It is built twice — once bundled
into the Electron app, once for the browser (`vite.web.config.ts`) and served at
`/app` — from the same source. Every use of the Electron bridge in it is written
as `window.chitchak?.…` for that reason: what a browser cannot provide is
guarded at the point of use, not compiled out.

## Design

The visual language borrows from studio and broadcast hardware rather than from
chat apps, because the product's real job is showing you who is audible.

- **Warm graphite** surfaces, deliberately not the blue-black of gaming chat
- **Brass** means selection and "you". **Signal teal** means live audio, and
  nothing else in the app is allowed to use it — colour always carries meaning
- **Archivo** for UI, **IBM Plex Mono** for readouts, counts and keybinds
- No server icon rail. Servers live in a labelled switcher in the top bar, which
  gives the channel list and the call the full width

**A call is a place, not an overlay.** Joining a room switches the main pane to
the call — only the people in it, nothing else. Reading a text channel switches
back without leaving the call. They are two views you move between, rather than
a call strip permanently squatting above a chat log.

The sidebar reflects that: text channels are a quiet, compact list (no leading
`#`), while voice rooms are **cards** — the substance of a voice app. Each has a
signal rail down its left edge that lights when someone inside is talking, a
monospace occupancy readout, and the faces of who is in there. You can see into
a room before deciding to enter it. The room you are in expands to show its full
roster, attached to the card as one block.

The signature element is the **level meter**: three bars driven by real
`audioLevel` data from the SFU, used at every size — beside a name in the
roster, under a face in the call, inside a room card. Not a boolean speaking
dot; the actual signal.

When someone shares a screen it becomes the stage and everyone else drops to a
filmstrip beneath it. Shares and cameras letterbox rather than crop, and either
can be taken fullscreen (button, or double-click).

## Ranks and permissions

A rank is a named bundle of permissions plus a position in a hierarchy. Every
member holds their server's default rank implicitly and any number of others on
top; effective permissions are the union.

Two rules keep the system from being a backdoor, and both are enforced on the
server regardless of what the client offers:

- **You cannot manage a rank at or above your own.** Without it, anyone with
  Manage ranks could promote themselves to the top.
- **You cannot grant a permission you do not hold.** Without it, Manage ranks is
  equivalent to Administrator: make a rank with everything, assign it, done.

Channels can override a rank's permissions — deny `View channel` to the default
rank and allow it to one other, and you have a private channel. Denies apply
before allows, so an allow on a specific rank beats a broad deny.

Voice permissions are enforced by the **SFU**, not by the interface: the join
token's publish grant is built from `Speak`, `Use camera` and `Share screen`, so
a modified client that re-enables its own buttons still cannot transmit.

Server-deafen works the same way. Muting someone is easy — stop their track.
Deafening is the harder half, because you cannot ask a client not to listen and
expect it to comply, so the SFU revokes their subscribe permission and stops
forwarding anyone's audio to them at all.

`services/permissions.ts` is the whole model — resolution, hierarchy, and
channel visibility.

## What works

- Register / sign in, with token rotation and refresh-reuse detection
- **Profile**: display name, username, bio, accent colour, avatar upload
- **Servers**: create, join by invite, rename, icon, delete
- **Server settings**: overview, channel management, members, invites
- **Channels**: any number of text and voice channels per server, with topics,
  user limits, reordering, editing and deletion
- **Voice**: join, leave, mute, deafen, live level meters, per-channel limits,
  occupancy visible before you join
- **Ranks**: colours, hierarchy, per-permission editing, assignment, and
  per-channel overwrites for private channels
- **Moderation**: kick, ban (with a ban list and message purge), server-mute,
  server-deafen, give and take ranks, move between voice channels,
  force-disconnect — all rank-gated
- **Profile cards and a moderation menu**: left-click a name for the card,
  right-click for actions. Same gesture everywhere — call, roster, chat
- **Video**: camera on/off and screen sharing with a source picker, with the
  presented screen taking over the strip layout
- **Messages**: edit your own, delete your own, delete anyone's with Manage
  messages
- **Invites**: expiry, use limits, a list of active invites, and revocation
- Push-to-talk and voice-activity modes; microphone, output and camera
  selection; echo cancellation, noise suppression and AGC toggles
- Text chat with history, message grouping, typing events
- Presence across multiple clients per account
- Gateway reconnects with jittered backoff; disconnects clear voice ghosts

Verified end to end with a headless two-client test (19 checks) covering the
whole realtime path: SFU credentials, token scoping, join/leave fan-out, mute
and camera propagation, server-enforced deafen, profile broadcast, text
delivery and disconnect cleanup.

## Known limits

These are deliberate stopping points, not oversights.

**Push-to-talk is only true hold-to-talk while the window is focused.** Electron's
`globalShortcut` fires on key press and has no release event, so when the app is
in the background the key toggles transmission instead of holding it. Real global
hold-to-talk needs an OS-level hook — `uiohook-napi` is the usual answer, at the
cost of a native module in the build.

**No per-member permission overrides.** Channel overwrites target ranks, not
individuals, so granting one person access to a channel means giving them a
rank. Adding member overwrites means widening the `channel_overwrites` primary
key to carry a subject type; the resolution order in
`protocol/permissions.ts` already anticipates it.

**Rank changes do not disturb a live call.** The SFU token is minted at join
time, so revoking someone's `Speak` mid-call does not take effect until they
rejoin. The fix is to have the moderation endpoint also apply a server mute, or
to re-issue tokens on rank change.

**Avatars and icons live in Postgres**, as `bytea` rows in the `images` table.
At 256×256 that is tens of kilobytes each, it needs no second system, and there
are no signed URLs to get wrong. It stops being the right answer the moment
users upload full-size media — at that point the `images` table becomes a
pointer into object storage and only `services/serialize.ts` changes.

**Screen share has no source picker of our own.** It uses the browser's
`getDisplayMedia`, so Electron shows the system chooser. A custom picker with
thumbnails needs `desktopCapturer` in the main process.

**Joining a new server needs a reconnect.** The gateway captures a user's guild
membership at identify time, so a guild joined mid-session does not route events
until the socket reconnects. The client reloads after joining to force this.
The fix is a `guild:join` event that updates the live session's routing set.

**Rate limiting is per-instance.** `@fastify/rate-limit` keeps counters in
process memory, so running more than one API instance multiplies the effective
limit. Point it at the Redis store before scaling out — Redis is already there.

**Tokens are in `localStorage`.** Fine for a dev build, but any renderer-side
script injection can read them. Electron's `safeStorage` API encrypts against the
OS keychain and is the right home for them in a shipped app.

**No TURN server.** Clients behind symmetric NAT or restrictive corporate
firewalls may fail to establish media. LiveKit can be configured with TURN over
TLS on 443, which is what makes voice work from locked-down networks.

## Debugging the client

In development the main process mirrors the renderer's console into the
terminal running `npm run dev`, and opens Chrome DevTools Protocol on port 9222.
Both are off in a packaged build.

That means a UI-triggered bug can be reproduced without touching the UI:

```js
// From any Node script, over CDP - or straight into the DevTools console.
window.__chitchak.getState().joinVoice(channelId);
window.__chitchak.getState().voiceConnection;  // 'connecting' | 'connected' | ...
window.__chitchak.getState().voiceError;
```

`__chitchak` is the Zustand store, exposed under `import.meta.env.DEV` only. Driving
the real store beats reproducing the app's behaviour in a test harness, which
can pass while the app fails.

### Electron permissions are one handler for several capabilities

`session.setPermissionRequestHandler` in `electron/main.ts` gates more than it
looks like it does. Chromium routes `media` (microphone and camera),
`display-capture` (screen sharing) **and `fullscreen`** through it, so a handler
that allows only what it thinks it needs silently breaks the rest.

Denying `fullscreen` is the nastiest of these: `element.requestFullscreen()`
then neither resolves nor rejects. It hangs, no error is thrown, and fullscreen
simply does nothing. If a capability mysteriously does nothing at all, check
that allowlist before looking anywhere else.

`setPermissionCheckHandler` needs the same list — some capabilities arrive as
synchronous checks rather than requests, and its default is also deny.

## Troubleshooting voice

**Keep the SFU and the client on matching versions.** `livekit-client` in
`apps/desktop/package.json` is pinned exactly, and `livekit/livekit-server` in
`docker-compose.yml` is pinned to a version that speaks the same RTC protocol.
Upgrade them together.

This is not cosmetic. A client newer than the server asks for an RTC path the
server does not have, silently falls back to the old one, and connects — but
its engine stays in a retry state, so the room reports `reconnecting`
indefinitely while media is genuinely flowing. The app surfaces that as a
connection failure. It looks exactly like a network problem and is not one.
The tell is in the renderer console:

```
Initial connection failed: v1 RTC path not found.
Consider upgrading your LiveKit server version – Retrying
```

**"Connected to the voice server, but no audio path could be opened."**

If versions match and this still appears, the SFU is advertising an address the
client cannot route to. `rtc.node_ip: 127.0.0.1` in `infra/livekit.yaml` is what
prevents that locally — without it the container advertises its Docker bridge
address, which the host reaches only by accident.

```bash
docker logs chitchak-livekit | grep "starting LiveKit"   # expect nodeIP: 127.0.0.1, and the version
netstat -an | grep '788'                             # expect 7880, 7881 listening
```

To see which candidate pair carried a call, look for `participant active` in the
SFU log — it lists every local and remote candidate and marks the selected one.

If you have a VPN, its adapter adds candidates of its own and may be selected;
that is normal and not a fault.

## Before deploying

- Replace `JWT_SECRET` and the LiveKit key pair — the server refuses to start in
  production with the placeholders, but check anyway
- Set `rtc.use_external_ip: true` and `node_ip` in `infra/livekit.yaml`
- Terminate TLS in front of both the API and the SFU (`wss://`)
- Move rate limiting to the Redis store
- Add TURN
