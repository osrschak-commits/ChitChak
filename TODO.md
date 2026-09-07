# What is not done yet

Things worth doing, roughly in the order they will start to hurt. Not a wish
list — everything here is something that is either already a gap or becomes one
the moment more than a handful of people use this.

## Offsite backups

**The gap:** backups run nightly and are verified by a weekly restore, but every
copy sits on the machine it is backing up. That covers a bad migration or a
deleted table. It does nothing about a dead disk or a lost VPS, which is the
case backups exist for.

**What it needs:** a bucket and credentials. `scripts/backup.sh` already takes
`BACKUP_REMOTE` — an rclone remote or an scp target — and copies each dump off
the box when it is set. Nothing else has to change.

The database compresses to about 50 KB, so Cloudflare R2 and Backblaze B2 both
cover it inside their free tiers, permanently. See the Offsite section in
DEPLOY.md.

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
