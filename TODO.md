# What is not done yet

Things worth doing, roughly in the order they will start to hurt. Not a wish
list — everything here is something that is either already a gap or becomes one
the moment more than a handful of people use this.

## Offsite backups — done

Backups now go to Cloudflare R2 (`r2:chitchak-backups`) as well as staying on
the box. The dump is copied nightly and kept by date; the uploads directory is
mirrored, so a second run transfers nothing.

Verified by pulling the dump back out of the bucket: gzip intact, 25 tables,
user and attachment rows present, byte-for-byte identical to the local copy.

Two things to know about the setup:

- `BACKUP_REMOTE` lives in `.env.production`, not in the crontab, so re-running
  `install-backups.sh` cannot silently unset it.
- The remote needs `region=auto` in the rclone config. Without it R2 answers
  every request with 403, which reads like a bad credential and is not one.

## Email — done

Password resets are sent through Resend. Free tier: 3,000/month, 100/day, which
is a long way above what resets will ever need.

Verified on 2026-09-09 twice over: against a local SMTP server (the whole loop -
link works, new password signs in, old one dead, replay refused, unknown address
sends nothing) and then against the live deployment, which logged `mail sent`
for a real reset to a real address.

- DNS is at **Fasthosts** (`ns1/2/3.livedns.co.uk`), not IONOS - that is the
  server's host, not the domain's.
- Resend uses CNAMEs for sending (`rsend`, `send`) rather than a TXT SPF record,
  plus a DKIM TXT at `resend._domainkey`. DMARC was left off: it is optional and
  `p=none` only collects reports nobody reads.
- `MAIL_FROM` must be a verified domain. Blank falls back to `noreply@localhost`
  and every provider rejects it.
- The API key passed through a chat log, so it is worth rotating at some point -
  Resend keys are sending-access only and revoking one is two clicks. Same note
  as the Paddle sandbox key.

## Platform-level moderation — done

Anyone can report a message or a person; staff read the queue and can suspend an
account, or lift a suspension, from the Staff tab. Reports snapshot the message
when they are filed, so the evidence survives it being deleted, and every
suspension and decision is recorded in `staff_actions` against a name.

A suspension is not deletion and not a guild ban: nothing is erased, and lifting
it gives back the servers, friends and history untouched. It reaches the session
the person is sitting in - their sockets are closed, their tokens invalidated,
and refresh is refused - and it says why, to them, on the sign-in screen.

**`PLATFORM_ADMINS` has to be set for any of it to be reachable.** It is a
comma-separated list of user ids read at boot, and it is empty by default, so a
deployment nobody has configured has no staff: reports can be filed and nobody
can read them. See `.env.production.example`.

Two things deliberately left:

- No appeals route. Somebody suspended is told the reason and nothing else; if
  they want to argue they have to find an operator another way. Fine while that
  is one person; a real gap once it is not.
- Staff cannot be suspended through the API. Removing an operator means taking
  them out of `PLATFORM_ADMINS` and redeploying, which is deliberate - an app
  that can lock out its own operators is one compromised session away from
  having none.

## An update that Macs can install themselves

Squirrel.Mac will not swap in a bundle whose signature it cannot verify, and the
build is unsigned, so macOS is told there is a new version and handed a download
link. An Apple Developer ID ($99/year) is what turns that back into a silent
update; deleting the `isMac` branches in `apps/desktop/electron/updater.ts` is
the rest of it.

## Images out of Postgres

Avatars and server icons are `bytea` rows. At a few hundred users that is
convenient and costs nothing. At a few thousand it means every backup drags them
along and the database is mostly pictures. The move is to object storage, and
only `services/serialize.ts` and the image routes should need to change.

## A grace period on account deletion

Deleting an account is immediate and irreversible. Most services hold the
account for a fortnight so that a regretful — or compromised — user can get it
back. Ours cannot.

## Username changes

Usernames can be changed freely, and friend requests are addressed by username.
So a handle written down yesterday may belong to nobody today, and could later
belong to someone else. Nothing breaks, because friendships key on ids, but the
longer it stays true the stranger "add by username" gets. A cooldown, or a
history of past names, would settle it.

## Paddle live approval

Sandbox works end to end. Going live needs Paddle to review the account, which
is a wait rather than a switch - start it well before you want to launch.

When approved:
1. Generate **live** credentials (API key, client-side token, webhook secret) and
   recreate the catalogue in live mode - sandbox ids do not carry over.
2. Point the live notification destination at
   `https://api.chitchak.com/api/webhooks/paddle`.
3. Set the live default payment link to `https://chitchak.com/pay`.
4. Update the `PADDLE_*` values in `.env.production`, set
   `PADDLE_ENV=production`, redeploy.
5. Regenerate the sandbox API key - the current one passed through a chat log.

The subscription now grants 2 keys, the plates, 1080p60 streams and a 100MB
upload cap against 10MB free. Standard emoji are in for everybody, and custom
per-guild emoji shipped for subscribers — everything promised is now built.

## Turn off PRE_LAUNCH on launch day

`PRE_LAUNCH=true` is set in `.env.production`, so every account created gets the
Founder badge. Set it to `false` and restart the server on the day the doors
open properly, or the badge quietly stops meaning anything — a mark for being
here first is worth exactly as much as the claim is true.

    # on the box, launch day
    sed -i 's/^PRE_LAUNCH=true/PRE_LAUNCH=false/' .env.production
    docker compose -f docker-compose.prod.yml --env-file .env.production up -d server

Nothing reminds you. This file is the reminder.

## Key packs buy chest openings

Keys are sold for money, and keys now open a chest that returns a random
cosmetic. That is a paid loot box, whatever it is called in the interface, and
in several countries it is a regulated one — the UK, Belgium and the Netherlands
have all taken a view.

The mitigation already in place is that cosmetics cannot be sold, traded or
cashed out, which is the line most regulators actually draw. It holds only while
that stays true: building the marketplace or trade system that has been talked
about would cross it, and would want proper advice first.

Parked deliberately rather than forgotten. The options, if it needs settling:
sell chest openings directly rather than a currency, disclose odds at the point
of purchase (they are already shown), or restrict paid openings by age.

## The stream fixes have never been tested with two people

`adaptiveStream` and `dynacast` are off, screen audio is captured without AGC,
noise suppression or echo cancellation, and it is published at 96kbps with DTX
off and RED on. All of that was reasoned from the symptoms — quiet audio, a
stream that vanished, a long wait before it played — and none of it has been
watched by a second person on a second machine, which is the only test that
counts. Worth doing before anyone is invited who would be annoyed by it.

(`restrictOwnAudio`, the Electron 33 → 44 fix for the same symptom on the call's
own audio, is built on the separate `electron-44` branch and unmerged pending
that same two-person test — not part of this branch's work.)

## Mobile: the layout is done, the app is not

2026-09-18. Decided: an iOS app wrapping the existing web client with
Capacitor, not a responsive site for phone browsers (chitchak.com will gate
phones to "download the app" once that page exists - it does not yet).

Done: the single-pane layout below `@media (max-width: 860px)` in
`styles.css` - see CLAUDE.md's "Things that will bite you" for how it is
wired. Verified in a desktop browser's device toolbar at 375×812: sign-in,
every server/DM/channel/members navigation and the back button, a profile
dialog, and a real voice call, with no horizontal overflow anywhere in that
flow. Not yet touched: ServerSettingsDialog, GuildDialog, the emoji/screen
pickers, and search - anything opened less often than the main flow above.

Also done, since the above: `@capacitor/core`, `@capacitor/cli` and
`@capacitor/ios` are installed, and `capacitor.config.ts` points `webDir`
at `dist-capacitor` - its own build (`npm run build:capacitor`, from a new
`vite.capacitor.config.ts`), not `dist-web`. It has to be its own build
because `base` differs: `dist-web` is mounted at `/app/` for apps/site,
which breaks the moment a webview serves index.html from the bundle root
instead, so `dist-capacitor` uses `base: '/'`. No `--mode` flag - a plain
`vite build` already defaults to production and loads `.env.production`,
so this build talks to the real API and SFU like the installer does, not
localhost. Verified: builds clean, `assertAssetsResolved` passes, and the
built `index.html` has root-relative asset paths and the production CSP
baked in.

Also done: `npx cap add ios` ran on a Mac and the generated Xcode project
is committed at `apps/desktop/ios/` (SPM, not CocoaPods - no `Pods/` to
gitignore beyond what Capacitor's own `.gitignore` there already covers).
It builds, runs on a real signed device with a paid Apple Developer
account, and a real account can sign in - the server's CORS allowlist
needed `capacitor://localhost` added (`apps/server/src/index.ts`), since
that origin is neither empty (Electron) nor the website's (`CLIENT_ORIGIN`).

Also done, found from that first real-device run: `Info.plist` had no
`NSMicrophoneUsageDescription`/`NSCameraUsageDescription`, so iOS was not
denying mic/camera access, it was killing the app outright for touching
privacy-gated hardware undeclared - both added. `.scrim`'s mobile padding
did not know about `env(safe-area-inset-top)`, so a dialog's close button
sat almost under the notch - now padded by the safe area on both edges.
The live-call controls (mute/camera/share/leave) lived only in the desktop
rail's `CallBar`, invisible on the phone layout's call screen since there
is no rail there - `CallView` now renders its own copy, shown only below
the breakpoint. A landscape webcam cropped hard under `cover` in a narrow
phone-width tile - letterboxed instead on mobile, same reasoning as a
shared screen. And the screen-share button is disabled with an explanatory
title when `navigator.mediaDevices.getDisplayMedia` does not exist, which
is unconditionally true in an iOS WKWebView - see the unstarted item below
for what actually fixes that rather than just explaining it.

Not done, in the order it likely needs doing:

- **TestFlight.** The paid Developer account that got a real device signed
  is also what TestFlight needs - distributing further than "phones this
  Mac has plugged in" from here is a distribution setting, not new work.
- **Sharing a phone's own screen.** iOS's WKWebView has no
  `getDisplayMedia` at all - not a permission to request, a capability the
  platform does not hand to a webview. The real fix is a native Capacitor
  plugin wrapping ReplayKit's broadcast upload extension, which is its own
  scoped project, not a quick follow-up. Watching someone *else's* shared
  screen from a phone is unaffected - that is just an incoming video track.
- **Safe-area padding elsewhere.** The top bar, the composer, dialogs and
  the mobile call bar all know about the safe area now; whatever is still
  missing will be obvious once more of the app has actually been used on a
  notched device rather than guessed at.
- **Background voice.** A backgrounded or locked-screen webview stops
  running JS and can drop the mic - untouched so far. Needs a native
  Capacitor plugin (CallKit + a VoIP push, on iOS) before a call reliably
  survives someone locking their phone. The one thing in this whole effort
  that is a real unknown rather than a known amount of work.
- **Push notifications.** The bell only updates while the gateway socket is
  open; closed or backgrounded, nothing arrives. Needs server-side APNs
  integration (a device-token table, sending on the same events that already
  create a row in `notifications`) plus the Capacitor push plugin.
- **App Store in-app purchase.** Keys/chests are sold through Paddle today.
  The moment this is a listed iOS app, Apple requires its own IAP for
  digital goods and takes its cut - a business decision as much as a
  technical one, and it sits next to the loot-box note above, not instead of
  it.
- **The mobile web gate.** A phone hitting chitchak.com should be told to
  get the app rather than shown the desktop-shaped marketing site - Discord's
  own behaviour, and the reason there is no responsive-web workstream here at
  all. Cheap once the app exists to point at; pointless before then.
