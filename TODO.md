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

## Email — waiting on a provider account, nothing else

`SMTP_URL` is unset in production, so password resets are written to the server
log instead of being sent and someone has to read them out by hand. Fine for
friends, unworkable the moment somebody you cannot message forgets a password.

**The code is verified working.** It had never run — the send path is only
reached when a real mail server answers, so it had executed zero times since it
was written. Tested against a real SMTP server on 2026-09-09, the whole loop:
ask for a reset, the mail is delivered with the right sender and subject, the
link points at `APP_URL`, the token works, the new password signs in, the old
one is dead, and replaying the link is refused. An unknown address gets the same
204 and sends nothing, so the endpoint cannot be used to test which addresses
have accounts.

`SMTP_URL`, `MAIL_FROM` and `APP_URL` are already wired through
docker-compose.prod.yml. So all that is left is an account:

1. Pick a provider — Resend, Postmark, SES, Fastmail, anything that gives you
   an SMTP username and password.
2. Set both `SMTP_URL` and `MAIL_FROM` in `.env.production`. `MAIL_FROM` must be
   an address the provider will let you send as; left blank it defaults to
   `noreply@localhost`, which every provider will reject.
3. Add the SPF and DKIM records they give you to the chitchak.com DNS. Without
   them the mail lands in spam, which for a password reset is the same as not
   sending it.
4. Restart the server, then actually request a reset for a real address and
   check it arrives.

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
