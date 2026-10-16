# Self-hosted Cap (Loom replacement)

This fork runs Cap on a free Oracle Cloud server with:

- **Public share links** at `https://<your-domain>/s/<video-id>`, each one public, password-protected, or private to you.
- **Guest comments and reactions**: teammates comment with just a name, no account. You see who watched in **Seen by**, and view counts work without paid analytics.
- **Email notifications** through Gmail SMTP, and **nightly backups** to Cloudflare R2.
- **Chrome extension** recording (screen, tab, camera, mic) that uploads while you record and copies the share link the moment you stop.
- **Free AI transcripts, titles, summaries and chapters** via Groq's free Whisper + LLM tier.
- **Every Pro feature unlocked**: self-hosted builds treat every user as Pro.
- **Single-owner sign-up**: only the email you set can create an account.

Fork-specific changes live on the `self-host` branch. Pull upstream improvements with:

```bash
git fetch upstream && git merge upstream/main
```

## Architecture

| Service | Purpose |
| --- | --- |
| `caddy` | HTTPS (automatic certificates) for the app and the video storage hostnames |
| `cap-web` | Next.js app, API, share pages, background jobs (`ghcr.io/rcirwin/cap-web:self-host`) |
| `media-server` | FFmpeg processing (`ghcr.io/rcirwin/cap-media-server:self-host`) |
| `mysql` | Database |
| `minio` | S3-compatible video storage, served at `s3.<your-domain>` |
| `cron` | Re-runs stalled processing every 15 minutes |

Images are built by `.github/workflows/self-host.yml` on every push to `self-host`. That workflow also builds the Chrome extension.

## 1. Oracle Cloud server (free)

1. Sign up at <https://signup.cloud.oracle.com>. Pick a **home region** near you (e.g. Canada Southeast (Toronto), or Montreal). Always Free ARM servers only exist in your home region, and you cannot change it later. A card is required for verification only.
2. **Compute → Instances → Create instance**
   - **Image:** Canonical Ubuntu 24.04.
   - **Shape:** *Change shape* → *Ampere* → `VM.Standard.A1.Flex`, **2 OCPU / 12 GB** (the current Always Free allowance).
   - **Networking:** create a new VCN with a public subnet, and keep *Assign a public IPv4 address* on.
   - **SSH keys:** *Paste public key* → contents of `~/.ssh/cap_oracle.pub`.
   - **Boot volume:** *Specify a custom size* → 150 GB. The free allowance is 200 GB total, and videos live here.
   - If you see *Out of capacity*, try another availability domain or retry later.
3. Open the firewall: instance → *Subnet* → *Security Lists* → default list → **Add Ingress Rules**:
   - Source `0.0.0.0/0`, TCP, destination port `80,443`
   - Source `0.0.0.0/0`, UDP, destination port `443`
4. Optional but recommended: upgrade the account to *Pay As You Go*. Usage inside Always Free limits stays $0, and it stops Oracle from reclaiming "idle" free servers.

## 2. Free domain (DuckDNS)

1. Sign in at <https://www.duckdns.org> and add a subdomain, e.g. `ryan-videos`. Set its IP to the server's public IP.
2. Copy your DuckDNS token; the installer uses it to keep the IP up to date.
3. `s3.ryan-videos.duckdns.org` resolves automatically. Nothing else to add.

`sslip.io`/`nip.io` are not on the Public Suffix List. Every user of those names shares one Let's Encrypt rate limit, so certificates often fail; DuckDNS does not have this problem.

## 3. Groq API key (free)

Create a key at <https://console.groq.com/keys>. The free tier covers about 8 hours of transcription per day. The same key powers AI titles, summaries and chapters.

## 4. Install

```bash
ssh -i ~/.ssh/cap_oracle ubuntu@<server-ip>
curl -fsSL https://raw.githubusercontent.com/rcirwin/Cap/self-host/self-host/install.sh -o install.sh
sudo bash install.sh
```

The installer asks for your domain, your email (the only allowed account), the Groq key and the DuckDNS token. It generates all other secrets into `/opt/cap/.env` (mode 600), opens the OS firewall, starts everything, and waits for HTTPS.

Sign in at `https://<domain>/login`. No email provider is configured, so get the one-time code with:

```bash
sudo /opt/cap/login-code.sh
```

Sessions last a long time, so you rarely need this.

## 5. Chrome extension

1. GitHub → Actions → **Self-host build** → latest run → download **cap-chrome-extension** and unzip it.
2. `chrome://extensions` → enable *Developer mode* → **Load unpacked** → choose the unzipped folder.
3. Its ID must be `fonfkofcnfolpcfekellfjedolghophf`. That ID is pinned by `CAP_EXTENSION_MANIFEST_KEY` and must match `CAP_CHROME_EXTENSION_ID` on the server.
4. Click the extension → sign in → record. When you stop, the share link is already on your clipboard.

The extension's server URL comes from the `CAP_SERVER_URL` repository variable at build time. You can also change it on the extension's Options page.

## Per-video access

On a video's page or in the dashboard:

- **Public:** anyone with the link can watch.
- **Password:** viewers must enter the password you set.
- **Private:** only you, signed in.

New videos default to public. Set `CAP_VIDEOS_DEFAULT_PUBLIC=false` with `sudo /opt/cap/set-env.sh CAP_VIDEOS_DEFAULT_PUBLIC` to flip that.

## Comments from teammates (no account needed)

Anyone who can open a share link can comment, reply and react. The first time, they're asked for a display name, which is remembered in their browser. Guest comments show a small **Guest** badge.

- You get an in-app notification for each one, plus an email when email is set up.
- Guests can delete their own comments. As the video owner you can delete any comment on your videos.
- Private and password-protected videos stay protected: guests can only comment where they can already watch.
- Light rate limits stop spam: 20 comments per video per 10 minutes, 60 per hour overall, per visitor.
- Turn it off with `sudo /opt/cap/set-env.sh CAP_GUEST_COMMENTS` and enter `false`. The existing per-video and org settings for disabling comments or reactions still apply.

## Views and "Seen by"

View counts work without Tinybird. They're stored in your own database and shown on cap cards, share pages and the dashboard **Analytics** page.

- **Seen by:** on a video's share page, the **Activity** tab shows who watched, newest first. Only you and org admins can see it.
  - Signed-in viewers appear by name.
  - Guests who have commented appear by the name they gave.
  - Everyone else gets a generated nickname, such as "Anonymous Otter".
- Country and city breakdowns stay empty: Caddy doesn't provide location data on its own.

## Transcription options

Transcription auto-selects a provider:

1. `ASSEMBLY_API_KEY` set → AssemblyAI (upstream behavior).
2. Otherwise `GROQ_API_KEY` (or `TRANSCRIPTION_BASE_URL`/`TRANSCRIPTION_API_KEY`) set → OpenAI-compatible Whisper. The default is Groq `whisper-large-v3-turbo`.

To use OpenAI or a local Whisper server instead, put overrides in `/opt/cap/extra.env` and restart:

```env
TRANSCRIPTION_PROVIDER=openai-compatible
TRANSCRIPTION_BASE_URL=https://api.openai.com/v1
TRANSCRIPTION_API_KEY=sk-...
TRANSCRIPTION_MODEL=whisper-1
```

Audio is re-encoded to 16 kHz mono before upload, and long recordings are split into chunks so they stay under provider size limits.

## Email notifications (Gmail, free)

Cap emails you when someone comments on a video (at most one email per video every 15 minutes) and emails sign-in codes, so you no longer need `login-code.sh`.

1. Turn on 2-Step Verification for your Google account, then create an app password at <https://myaccount.google.com/apppasswords> (name it "Cap").
2. On the server: `sudo /opt/cap/configure-email.sh` and paste the 16-letter app password.
   The script restarts Cap and sends you a test sign-in code.

Any SMTP provider works: run it with `SMTP_URL=smtps://user:pass@host:465` (and optionally `EMAIL_FROM="Cap <me@example.com>"`). If `RESEND_API_KEY` is set, Resend is used instead.

## Backups (Cloudflare R2)

`backup.sh` runs nightly at 08:00 UTC and copies everything off the server:

| In the bucket | What | Kept |
| --- | --- | --- |
| `db/` | Gzipped MySQL dump | 14 days |
| `config/` | `.env` (secrets!), compose file, Caddyfile | 14 days |
| `videos/` | Incremental mirror of all recordings | Always |
| `deleted/` | Recordings removed from Cap | 30 days |

One-time setup:

1. Cloudflare dashboard → **R2 Object Storage** → **Create bucket** → name it `cap-backups` (keep it private).
2. **R2** → **Manage API tokens** → **Create API token**: permission **Object Read & Write**, apply to the `cap-backups` bucket only.
3. Copy the **Access Key ID**, **Secret Access Key** and the **S3 endpoint** (`https://<account-id>.r2.cloudflarestorage.com`).
4. On the server: `sudo /opt/cap/configure-backups.sh` and paste them. It runs the first backup immediately and schedules the nightly one.

R2's free tier covers 10 GB of storage; beyond that it is about $0.015/GB-month. Check status with `journalctl -u cap-backup.service` or `cat /var/backups/cap/last-success`.

**Restore** onto a fresh server: run `install.sh` as usual, then `sudo /opt/cap/restore.sh` (type `RESTORE` to confirm). It replaces the configuration, database and videos with the latest backup.

## Operations

| Task | Command (in `/opt/cap`) |
| --- | --- |
| Update to latest build | `sudo docker compose pull && sudo docker compose up -d` |
| Status | `sudo docker compose ps` |
| Logs | `sudo docker compose logs -f --tail 100 cap-web` |
| Change a setting | `sudo ./set-env.sh KEY` |
| Back up now | `sudo ./backup.sh` |

## License

Cap is AGPLv3. This fork is public, which satisfies the obligation to offer the modified source to people who use the server, including viewers of share links.
