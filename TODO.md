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

## Email

`SMTP_URL` is unset in production, so password resets are written to the server
log instead of being sent, and someone has to read them out by hand. Fine for
friends, unworkable beyond that. Needs a provider, and the SPF and DKIM records
it gives you, or the mail lands in spam — which for a password reset is the same
as not sending it.

## Platform-level moderation

Moderation today is per-server: kick, ban and mute inside a guild. There is no
way to remove someone from the platform, and no way for anyone to report
anything. Both become necessary the moment registration opens to strangers, and
neither is urgent while the signup code is on.

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

## Mobile

The web client runs in a phone browser but is laid out for a keyboard and a wide
window. Either a responsive pass over the existing client, or a real mobile app.
The site currently says "coming", which is a promise with a clock on it.

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
