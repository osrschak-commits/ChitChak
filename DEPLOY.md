# Putting ChitChak online

Getting from "runs on my machine" to "my friends can join" is two jobs: a server
they can reach, and an installer you can send them. This walks through both.

Budget roughly an hour, most of it waiting for DNS.

**What you need:** a domain name (~£10/year) and a VPS (~£4/month).

The provider does not matter — Hetzner, DigitalOcean, IONOS, OVH, Vultr and
Linode all work. What matters is:

- **Root access to a plain Linux box.** Not "web hosting", not cPanel, and not
  a platform like Vercel, Netlify, Railway or Heroku. Those only give you HTTP,
  and voice needs a raw UDP port they will not open.
- **A public IPv4 address.**
- **2GB of RAM or more.** 1GB is enough to run the stack but not reliably enough
  to build it.
- **Ubuntu 24.04**, or any recent Linux you are comfortable with.

A group of friends needs nothing more than that: the SFU forwards audio without
transcoding it, which is cheap.

---

## 1. Point a domain at the server

Create the VPS first so you have its IP, then add four DNS records:

| Type | Name  | Value              | For                             |
| ---- | ----- | ------------------ | ------------------------------- |
| A    | `@`   | your server's IPv4 | the website and the web client   |
| A    | `www` | your server's IPv4 | redirects to the apex            |
| A    | `api` | your server's IPv4 | the API and the gateway          |
| A    | `sfu` | your server's IPv4 | the SFU's signalling             |

Separate names because they are separate services. Media does not go through any
of them — it goes straight to the SFU on its own ports.

**If you registered the domain recently, the apex and `www` almost certainly
point at your registrar's parking page.** Those are the two records people
usually forget to change, and the symptom is Caddy failing to get a certificate
for a name that resolves perfectly well — just not to you.

DNS takes anywhere from a minute to a few hours. Check every name before
continuing; Caddy cannot get a certificate until they resolve to your server:

```bash
for name in yourdomain.com www.yourdomain.com api.yourdomain.com sfu.yourdomain.com; do
  echo "$name -> $(dig +short "$name" | tail -1)"
done
```

## 2. Open the firewall — in both places

Most providers put a firewall in their control panel that is **separate from the
one on the server**. IONOS, OVH, AWS, Oracle and Hetzner all do. Rules you add
with `ufw` over SSH have no effect on it, and it usually defaults to allowing
very little.

Get this wrong and you get the confusing failure rather than an obvious one:
people join a call, see each other, and hear silence — signalling on 443 is
open, media on UDP 7882 is not.

So open these in your provider's panel **and** on the server:

| Port       | Why                                                       |
| ---------- | --------------------------------------------------------- |
| 22/tcp     | SSH                                                        |
| 80/tcp     | Let's Encrypt's certificate challenge                      |
| 443/tcp    | The API and SFU signalling, over TLS                       |
| 7881/tcp   | WebRTC media fallback, for networks that block UDP         |
| 7882/udp   | WebRTC media — **the one people forget, and voice dies**   |
| 3478/udp   | TURN, for friends behind restrictive NAT                   |

On Ubuntu with `ufw`:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp && sudo ufw allow 3478/udp
sudo ufw enable
```

Postgres and Redis are deliberately **not** in that list. They have no published
ports in the production compose file and are reachable only from inside it.

## 3. Install Docker and the code

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in for this to take effect

git clone <your repo> chitchak && cd chitchak
```

## 4. Configure

One command writes the whole file with fresh secrets:

```bash
node scripts/generate-env.mjs --domain yourdomain.com --email you@example.com
```

It generates three unrelated secrets, sets the file to `chmod 600`, and prints a
signup code for your friends. It refuses to overwrite an existing
`.env.production`, because regenerating `JWT_SECRET` signs everyone out and
regenerating `POSTGRES_PASSWORD` locks the server out of its own database.

Pass `--signup-code none` if you genuinely want open registration — but on a
public domain, don't.

<details>
<summary>Filling it in by hand instead</summary>

Copy `.env.production.example` to `.env.production`, then generate each secret
separately with `openssl rand -base64 36` — a different one for
`POSTGRES_PASSWORD`, `JWT_SECRET` and `LIVEKIT_API_SECRET`. Set `CHITCHAK_DOMAIN` to
your domain with no subdomain, `ACME_EMAIL` to a real address, and `SIGNUP_CODE`
to something you can read out loud. Finish with `chmod 600 .env.production`.

</details>

## 5. Start it

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production \
  --profile tools run --rm migrate
```

The second command creates the database tables. Re-run it after any deploy that
changes the schema. The build takes a few minutes the first time: it compiles the
API, and it compiles the web client that `https://yourdomain.com` serves.

Check it came up:

```bash
curl https://api.yourdomain.com/health     # {"status":"ok",...}
curl -I https://yourdomain.com             # 200, the website
curl -I https://yourdomain.com/app/        # 200, the web client
docker compose -f docker-compose.prod.yml logs -f
```

If Caddy is stuck getting a certificate, DNS has not propagated yet or port 80
is closed. Those are the only two causes worth checking first.

## 6. Build the installer

Back on your own machine:

```bash
cd apps/desktop
cp .env.production.example .env.production
```

Edit it and replace `example.com` with your domain in all three values. **These
are compiled into the app** — a build with the wrong domain will not connect no
matter how the server is configured, so get them right before building.

```bash
npm run dist:win     # on Windows
npm run dist:mac     # on a Mac
```

The Windows installer lands in `apps/desktop/release/ChitChak-Setup-0.1.0.exe`,
about 85MB. The Mac build produces four files — a `.dmg` and a `.zip` for each
of `arm64` and `x64`, around 95MB each.

Neither machine can build for the other. electron-builder needs macOS to make a
`.dmg`, and the Windows toolchain only runs on Windows, so covering both
platforms means running the build twice on two machines.

**If you do not have a Mac**, GitHub's runners are one: the *Desktop (macOS)*
workflow in `.github/workflows/desktop-mac.yml` builds the same four files and
attaches them to the run. Trigger it from the Actions tab, or let it fire on the
`v*` tag that `npm run release` pushes. Download the artifact, unzip it, and
copy the files up with the same `scp` the release script uses:

```bash
scp -i ~/.ssh/id_ed25519_chitchak ChitChak-*.dmg ChitChak-*.zip ChitChak-*.blockmap \
  root@194.164.23.93:/root/ChitChak/updates/
# The manifest last - it is what tells running apps a new version exists.
scp -i ~/.ssh/id_ed25519_chitchak latest-mac.yml \
  root@194.164.23.93:/root/ChitChak/updates/
```

### Which file does a Mac user want?

`arm64` for any Mac from 2020 on (M1 through M4), `x64` for an Intel one. If in
doubt, the Apple menu → *About This Mac* names the chip.

### What to tell your friends

The builds are not code-signed on either platform, and both operating systems
say so in their own way.

**Windows** shows SmartScreen: "Windows protected your PC". They click *More
info* → *Run anyway*.

**macOS** is blunter. Gatekeeper refuses the app outright — *"ChitChak is
damaged and can't be opened"*, which is untrue but is what an unsigned,
quarantined app gets. Right-clicking → *Open* no longer clears it on current
macOS. This does:

```bash
xattr -dr com.apple.quarantine /Applications/ChitChak.app
```

So the instructions for a Mac are: open the `.dmg`, drag ChitChak to
Applications, run that one command, then open it. On first use it will ask for
the microphone, and — the first time someone shares their screen — for Screen
Recording, which macOS only applies **after the app is quit and reopened**.

Tell people to expect all of this. A download that throws a scary warning with
no explanation is one they should be suspicious of.

Signing costs around £200/year for a Windows certificate and $99/year for an
Apple one. For a handful of friends neither is worth it; if this ever grows,
they are the first things to buy — the Apple one more urgently, because it is
also what would let Macs update themselves.

They will also need the signup code you set in step 4.

## 7. The website, and the version that needs no download

`https://yourdomain.com` is a page with the download links on it, and
`https://yourdomain.com/app` is ChitChak running in the browser. Both come up
with the stack in step 5 — there is nothing extra to deploy, and no static host
to sign up for.

Send people the domain rather than a file. The page works out which build they
want, labels it with the current version and its size, and puts the warnings
above in front of them before they hit them.

**The download links are not baked into the page.** It reads the same
`latest.yml` and `latest-mac.yml` the desktop app reads, so publishing a release
updates the site by itself. `/download/` is the same directory, browsable, which
is where the page sends anyone whose browser blocked the script.

### What the browser version can and cannot do

It is the same client — `apps/desktop/src`, built for a browser instead of for
Electron — so chat, voice, video and channel management behave identically.
Three things a web page is simply not allowed to do:

| | Desktop | Browser |
| --- | --- | --- |
| Push-to-talk while another window has focus | yes | no — only while the tab is focused |
| Screen share source picker with thumbnails | ours, in-app | the browser's own dialog |
| Sharing computer sound with a screen | Windows only | no |
| Updating itself | Windows only | it is always current |

Everything else is the same code taking the same path.

### Two things worth knowing

**The web client is a real origin, and the API's CORS allowlist is one entry
long.** `CLIENT_ORIGIN` is set to `https://${CHITCHAK_DOMAIN}` in
`docker-compose.prod.yml`, which is why `www` redirects to the apex rather than
serving a copy: a second name would be a second origin, refused by the API and
holding its own separate login.

**A browser is a softer place to keep a session than a desktop app.** Tokens
live in `localStorage` either way, but on a public web origin any script that
gets onto the page can read them. The client loads no third-party code and its
CSP forbids doing so, which is the defence — worth keeping in mind before adding
an analytics snippet to it.

### Working on the site

```bash
npm run dev:site     # http://localhost:4321 — the page, with /app built in
```

The `/app` copy in that preview is built against the **live** API, which refuses
`localhost` by CORS, so it renders but cannot sign in. That is expected; use
`npm run dev:desktop` to actually work on the client.

---

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production \
  --profile tools run --rm migrate
```

Server-only changes need no new installer.

### Shipping a new version of the app

When the desktop client changes, one command builds it and publishes it:

```bash
npm run release            # 0.1.2 -> 0.1.3
npm run release -- minor   # 0.1.2 -> 0.2.0
npm run release -- 1.0.0   # exactly that
git push --follow-tags
```

That bumps the version, builds the installer for **the machine it runs on**, and
copies it plus a manifest to `/root/ChitChak/updates` on the server, which Caddy
serves at `https://api.chitchak.com/updates`.

Covering both platforms is two runs, and only the first sets the version:

```bash
# On Windows: bumps, builds the .exe, commits, tags.
npm run release
git push --follow-tags

# On a Mac, afterwards: same version, .dmg and .zip, no second commit.
git pull
npm run release -- --no-bump
```

The two manifests are separate — Windows apps read `latest.yml`, Macs read
`latest-mac.yml` — so shipping a Windows-only version is a coherent thing to do.
It just means Mac users stay where they are until a Mac build of it exists.

On Windows nobody needs telling. Every running copy checks the manifest 15
seconds after launch and every 30 minutes after, downloads the new build quietly
in the background, and offers an **Update ready · Restart** button in the top
right. Ignoring the button is fine — the installer runs when the app is closed,
so the next launch is on the new version either way. A call is never interrupted.

Updates are differential: the client compares block maps and fetches only the
parts that changed, which is why an 85 MB installer takes seconds rather than
minutes. That is also why old installers and their `.blockmap` files are worth
leaving in the updates directory rather than deleting.

**Macs cannot update themselves.** Squirrel.Mac, which is what does the swapping
there, verifies that the update it downloaded carries the same code signature as
the app already running — and an unsigned build has none to match. Rather than
download 95 MB in order to fail at the last step, the app notices the new
version and shows **Update available · Download**, which opens the right `.dmg`
for that machine's architecture. They drag it over the old copy, and clear
quarantine again:

```bash
xattr -dr com.apple.quarantine /Applications/ChitChak.app
```

An Apple Developer ID ($99/year) is what turns that back into a silent update;
deleting the `isMac` branches in `apps/desktop/electron/updater.ts` is the rest.

The only version that ever needs handing round by hand is the first one, because
a copy of the app has to exist before it can update itself — and on macOS, every
one after it.

## Backups

Everything that matters is in Postgres — accounts, servers, messages, and the
avatars, which are stored as rows rather than files.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U chitchak chitchak | gzip > chitchak-$(date +%F).sql.gz
```

Put that in a cron job and copy the result somewhere that is not this server. A
backup that lives only on the machine it is backing up is not a backup.

## If voice does not connect

The stack has a specific failure mode worth recognising: **signalling succeeds
and media does not**. People appear in the channel and hear nothing.

Almost always UDP 7882 is closed, or the SFU is advertising an address that
clients cannot route to. Check what it decided on:

```bash
docker compose -f docker-compose.prod.yml logs livekit | grep "starting LiveKit"
```

`nodeIP` should be your server's **public** address. If your provider puts the
machine behind a NAT gateway — some do — automatic discovery gets this wrong.
Set it explicitly in `infra/livekit.prod.yaml`:

```yaml
rtc:
  node_ip: <your public IP>
  use_external_ip: false
```

To see which path a call actually took, look for `participant active` in the
LiveKit log. It lists every candidate and marks the selected one.

## Hardening worth doing

Not required to get running, in rough order of value:

- **Automatic security updates**: `sudo apt install unattended-upgrades`
- **SSH keys only** — disable password login in `/etc/ssh/sshd_config`
- **Move rate limiting to Redis** if you ever run more than one API container;
  it currently counts per process, so the effective limit multiplies
- **Watch disk usage.** Avatars live in Postgres, so the database grows with
  uploads. Fine for a group of friends; revisit if it ever becomes a crowd
