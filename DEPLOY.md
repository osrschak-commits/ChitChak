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

Create the VPS first so you have its IP, then add two DNS records:

| Type | Name  | Value              |
| ---- | ----- | ------------------ |
| A    | `api` | your server's IPv4 |
| A    | `sfu` | your server's IPv4 |

Two subdomains because they are two services: the API and the SFU's signalling.
Media does not go through either — it goes straight to the SFU on its own ports.

DNS takes anywhere from a minute to a few hours. Check with `nslookup
api.yourdomain.com` before continuing; Caddy cannot get a certificate until it
resolves.

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
changes the schema.

Check it came up:

```bash
curl https://api.yourdomain.com/health     # {"status":"ok",...}
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
npm run dist:win
```

The installer lands in `apps/desktop/release/ChitChak-Setup-0.1.0.exe`, about 85MB.

### What to tell your friends

The build is not code-signed, so **Windows SmartScreen will warn them**: "Windows
protected your PC". They need to click *More info* → *Run anyway*. Tell them to
expect that, because a download that throws a scary warning with no explanation
is one they should be suspicious of.

Signing costs around £200/year for a certificate. For a handful of friends it is
not worth it; if this ever grows, it is the first thing to buy.

They will also need the signup code you set in step 4.

---

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production \
  --profile tools run --rm migrate
```

Rebuild and redistribute the installer only when the client itself changes.
Server-only changes need no new installer.

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
