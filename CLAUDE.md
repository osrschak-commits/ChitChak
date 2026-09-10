# ChitChak

A voice-first Discord-like app. Live at **chitchak.com**, API at **api.chitchak.com**,
one VPS at **194.164.23.93**.

## Layout

npm workspaces monorepo.

- `packages/protocol` — shared types and the gateway wire format. Build this first;
  the other two import from it.
- `apps/server` — Fastify + Drizzle + Postgres + Redis + LiveKit. HTTP routes in
  `src/http`, business logic in `src/services`, the WebSocket gateway in `src/gateway`.
- `apps/desktop` — Electron + React + Zustand + Vite. Also builds the web client that
  `apps/site` serves at `/app`.
- `apps/site` — the static marketing site, served by Caddy.

## Commands

    npm run dev                  # protocol, server and desktop together
    npm run typecheck            # all three projects
    npm run db:generate          # after changing db/schema.ts
    npm run db:migrate
    npm run release              # bumps, builds the .exe, uploads, commits, tags

Typecheck with `npx tsc --noEmit` inside `apps/desktop`, and `npm run -w
@chitchak/server build` for the server. Both are fast and worth running often.

## Deploying

Server-only changes need no installer. Client changes need both a site rebuild and a
desktop release, and forgetting the site is an easy mistake — the web client at
`/app` is built into the site image, not served from the server.

    ssh -i ~/.ssh/id_ed25519_chitchak root@194.164.23.93
    cd /root/ChitChak && git pull --ff-only
    # only when a migration was added:
    docker compose -f docker-compose.prod.yml --env-file .env.production \
      --profile tools run --rm --build migrate
    docker compose -f docker-compose.prod.yml --env-file .env.production \
      up -d --build server site

Then, on Windows, `npm run release && git push --follow-tags`.

Verify against the deployed bundle rather than the build succeeding — pull
`https://chitchak.com/app/` , find the `assets/index-*.js` it references, and grep it
for a string only the new code contains.

## Conventions

Comments explain **why**, not what — especially the non-obvious constraint that made
the code look the way it does. Several throughout the codebase document a bug that was
already fixed once; they are there so it does not come back. Match that density.

Prose in the interface is part of the work. Say what a thing does and what it costs,
in plain words, without marketing tone.

## Things that will bite you

- **`.env.production` on the box is not in git.** `PLATFORM_ADMINS`, `PRE_LAUNCH`,
  `SMTP_URL` and the Paddle keys live only there. `.env.production.example` documents
  them; check the real file before concluding something is unconfigured.
- **The dev server reads `.env` at boot.** Changing it needs a full restart, not just
  a tsx reload.
- **Messages are created over the gateway**, not by an HTTP route. Tests that POST to
  `/api/channels/:id/messages` get a 404 and look like a broken feature.
- **The create-guild response is `{ guild, channels }`.** `guild.id` is undefined; it
  is `guild.guild.id`.
- **Auth routes are `/api/auth/password/forgot` and `/password/reset`.**
- **Rate limits bite tests**: 10 registrations per 10 minutes, 10 logins per 5. Loop
  with a wait rather than reporting the 429 as a failure.
- **Windows loopback audio is the whole output mix**, so a screen share with sound
  carries the call itself back to everyone in it. Electron 33 offers no way to exclude
  our own audio. The setting in voice settings is the only cure.

## Testing

There is no test suite. Changes are verified by driving the real thing: a real server,
and a real browser over CDP. That has caught a lot that typechecks could not — options
a library silently ignored, UI that rendered nothing, tests that passed because they
were asserting against a 404.

Two rules learned the hard way:

- **Assert the setup before the thing.** A test that says "no forbidden item appeared"
  passes beautifully when nothing appeared at all.
- **Read the live object, not your own options.** `RTCRtpSender.getParameters()` is
  what settled whether the encoder settings were in force; the options object we passed
  in said nothing about whether they applied.

Python heredocs mangle `\n` and `\b` into control characters. Use the Edit tool for
anything with escapes in it.

## What is not done

See `TODO.md`. It is current, and includes the decisions that were deliberately parked
rather than forgotten.
