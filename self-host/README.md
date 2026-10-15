# Self-hosted Cap (Loom replacement)

This fork runs Cap on a free Oracle Cloud server with:

- **Public share links** at `https://<your-domain>/s/<video-id>`, each one public, password-protected, or private to you.
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

## Operations

| Task | Command (in `/opt/cap`) |
| --- | --- |
| Update to latest build | `sudo docker compose pull && sudo docker compose up -d` |
| Status | `sudo docker compose ps` |
| Logs | `sudo docker compose logs -f --tail 100 cap-web` |
| Change a setting | `sudo ./set-env.sh KEY` |
| Back up database | `sudo docker compose exec mysql sh -c 'mysqldump -ucap -p"$MYSQL_PASSWORD" cap' > cap.sql` |

## License

Cap is AGPLv3. This fork is public, which satisfies the obligation to offer the modified source to people who use the server, including viewers of share links.
