# ReelForge deployment (Derek's home server)

Follows the server runbook: Docker Compose + Traefik (`127.0.0.1:8080`) + Cloudflare Tunnel, no host ports, no router ports.

| Item | Value |
|---|---|
| Project directory | `/srv/projects/reelforge` (compose.yaml, .env mode 600, source) |
| Agent | container `reelforge-agent`, internal port 8080, `https://reelforge.derek2403.win` |
| Studio (editor) | container `reelforge-studio`, internal port 3001, `https://reelforge-studio.derek2403.win` |
| Traefik routers / services | `reelforge-agent`, `reelforge-studio` (unique) |
| Networks | `proxy` only (no database) |
| Persistent data | `/mnt/Storage1/app-data/reelforge/agent` (job journal, generated media), `/mnt/Storage1/app-data/reelforge/studio` (durable video copies, saved projects) |
| Health checks | agent `GET /availability`, studio `GET /` |
| Restart policy | `unless-stopped` (survives reboots and closed sessions) |
| Images | `node:24.13.0-bookworm-slim` (pinned), built locally |

## Secrets (`.env`, mode 600, never committed)

`BLOCKFROST_PROJECT_ID`, `SELLER_MNEMONIC`, `BUYER_MNEMONIC` (preprod only), `HIGGSFIELD_API_KEY`,
`OPENAI_API_KEY`, `SOKOSUMI_API_KEY`, `SOKOSUMI_COWORKER_API_KEY`, `ADMIN_TOKEN`.
Non-secret config: `AGENT_DOMAIN`, `STUDIO_DOMAIN`, `PUBLIC_BASE_URL`, `WEB_PUBLIC_URL`, `STUDIO_EDIT_URL`,
`IMPORT_ALLOWED_HOSTS`, `EXECUTOR_ENABLED` (0 = HTTP only / standby, 1 = settles payments + runs the Sokosumi coworker).

**One executor only.** Exactly one ReelForge instance may run with `EXECUTOR_ENABLED=1` (it signs escrow
transactions and claims Sokosumi Tasks). The agent also refuses to start while another process holds `data/server.lock`.

## Cloudflare routes (owner)

Networking -> Tunnels -> dereks-server -> Routes -> Add published application:

| Hostname | Service URL |
|---|---|
| `reelforge.derek2403.win` | `http://localhost:8080` |
| `reelforge-studio.derek2403.win` | `http://localhost:8080` |

Both go to Traefik, which routes by hostname. Local test before adding routes:

    curl -i -H 'Host: reelforge.derek2403.win' http://127.0.0.1:8080/availability
    curl -i -H 'Host: reelforge-studio.derek2403.win' http://127.0.0.1:8080/

## Update

On your PC: `git archive --format=tar -o reelforge.tar HEAD`, scp it to `/srv/projects/reelforge`, then on the server:

    set -e
    cd /srv/projects/reelforge
    tar -xf reelforge.tar && unlink reelforge.tar
    docker compose config --quiet
    docker compose up -d --build
    docker compose ps

Rollback: extract the previous archive and `docker compose up -d --build`. Data under app-data is untouched.

## Backups

    mkdir -p /mnt/Storage1/backups/reelforge/$(date +%F)
    tar -czf /mnt/Storage1/backups/reelforge/$(date +%F)/app-data.tgz -C /mnt/Storage1/app-data reelforge

Keep an encrypted off-server copy of `.env` (wallet mnemonics). Restore: stop the stack, extract the archive back
into `/mnt/Storage1/app-data`, `docker compose up -d`.

## Cutover from a laptop instance

1. Stop the laptop agent (single executor).
2. Copy its `packages/agent/data/` (jobs.json, media) into `/mnt/Storage1/app-data/reelforge/agent/`.
3. Set `EXECUTOR_ENABLED=1` in `.env`, `docker compose up -d`.
4. `pnpm --filter @reelforge/agent update-registry` (registry api_base_url -> new domain), put the new `MASUMI_AGENT_IDENTIFIER` in the server `.env`, restart, then `pnpm --filter @reelforge/agent registry-refresh` (the registry marks the entry Invalid if its first check saw the old identifier).
5. Update the Sokosumi coworker url (`pnpm --filter @reelforge/agent coworker-profile`).