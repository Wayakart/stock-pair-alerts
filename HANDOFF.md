# Engineering Handoff

## Objective

Turn this repository into a low-latency monitor for three distinct signals:

1. A genuinely new tokenized equity appears on Robinhood Chain or Solana.
2. A tokenized equity receives its first market or launchpad pair.
3. A new pool on a supported Base venue pairs any token with the official Venice VVV contract.

Do not treat every meme token paired with an existing stock as a new equity. Keep meme/project momentum analysis as internal research or route it to a separate channel later.

## Safety State

- Discord delivery is opt-in through `DISCORD_ALERTS_ENABLED=1`. It defaults to off in local examples and deployment workflows.
- The production droplet's two webhook values were also emptied manually on 2026-09-07. Do not restore them or enable Discord until shadow events have been reviewed.
- Rick autoscan must remain off while Discord is muted.
- Dry-run decisions are enabled. The repository does not execute trades.
- The shared weekly infrastructure kill switch is `$1,000`.
- Never commit provider keys, webhook URLs, billing tokens, or SSH private keys.

## Repository And Deployment

- GitHub: `Wayakart/stock-pair-alerts`
- Production host: DigitalOcean `167.172.131.186`
- App directory: `/opt/stock-pair-alerts`
- Environment file: `/etc/stock-pair-alerts/env`
- Services:
  - `stock-pair-robinhood.service`
  - `stock-pair-solana.service`
  - `stock-pair-base.service`
- Deployment workflow: `.github/workflows/deploy-digitalocean.yml`
- Deployment is manual. A push to `main` does not automatically restart production.

Use GitHub Actions secrets and variables already named in the deployment workflow. Do not put their values in issues, commits, logs, or this document.

## Current Production Status

Last checked 2026-09-09:

- Robinhood service: active.
- Solana service: failed closed at 2026-09-08 12:25 UTC.
- Solana failure: `budget telemetry unavailable: fetch failed` while required provider billing telemetry was unreachable. The `$1,000` budget was not exhausted.
- Discord webhook values on the droplet: empty.
- Solana was running `SOLANA_STREAM_MODE=standard-wss` and `SOLANA_WATCH_PROTOCOLS=pump` before it stopped.
- Base listener: implemented on branch `base-vvv-listener`, not deployed or started. The deployment gate defaults to `BASE_LISTENER_ENABLED=0` and requires separate paid Base HTTP/WSS endpoints.

Do not weaken the fail-closed budget policy without replacing it with bounded retry/grace behavior and tests. A transient telemetry outage should not silently remove spend protection.

## What Is Implemented

### Robinhood Chain

- QuickNode WebSocket listener with reconnects, heartbeats, checkpoints, and backfill.
- Protocol events:
  - Pons `PairTokenApprovalUpdated`
  - Long `LaunchCreated`
  - Flap `TokenQuoteSet`
  - Pair Fund canonical project/pool launch events
- Robinhood asset catalog refresh from `https://api.robinhood.com/rhj/assets` every five minutes.
- New project tokens paired with known stock numeraires are registered as momentum candidates.
- Persistent trade history, replay tooling, deduplication, FDV milestone updates, and high-signal filters.
- Pons approvals are recorded internally; Discord approval alerts are off by default.

### Solana

- Helius standard WebSocket and LaserStream gRPC connection modes.
- Pump.fun `Create` and `CreateV2` event decoding directly from stream logs.
- Pump launches are matched when their quote mint exists in the StonkFun stock map.
- Solana slot/signature checkpoints and reconnect replay for LaserStream.
- StonkFun catalog source: `https://www.stonkfun.xyz/api/public/v1/pairs?launchable=true`.

### Base

- Official VVV CA: `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf`.
- Filtered WebSocket subscriptions for Uniswap V4, Uniswap V3, Uniswap V2, Aerodrome AMM, and all three official Aerodrome Slipstream factories.
- Supports standard sealed logs and Flashblocks `pendingLogs` without polling.
- Persists raw matches before metadata enrichment in `state/base-events.ndjson` and deduplicates in `state/base.json`.
- Reconnect backfill subscribes first, then replays a persisted 32-block overlap.
- `pending-logs` mode also subscribes to sealed logs so each fast preconfirmation is explicitly marked confirmed.
- No Discord or Rick code path exists for Base during shadow collection.
- Uses the same QuickNode telemetry, `$1,000` budget state, and kill switch as the other listeners.

### Operations

- Persistent state and NDJSON event history.
- Shared alert cap: ten token alerts per rolling eight hours.
- Provider telemetry for QuickNode, Helius, and DigitalOcean.
- Weekly `$1,000` kill switch and DigitalOcean configured hard-cap check shared by all three listeners.
- URL redaction, status command, provider benchmarks, and focused tests.

## Important Coverage Gaps

### New Equity Catalogs

The realtime catalog caches are currently allowlists, not persisted snapshot diffs. A new Robinhood or StonkFun equity can enter a catalog without generating a dedicated new-equity event.

The scheduled `01/o1` poller has snapshot-diff logic, but it is not a substitute for the realtime path. The workflow previously failed before polling because dependencies were not installed; `npm ci` has now been added.

### Raydium And Native StonkFun

The Solana service currently subscribes only to Pump.fun. It does not observe native StonkFun launches or Raydium LaunchLab, CPMM, or CLMM initialization.

Raydium mainnet program IDs:

- LaunchLab: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- CLMM: `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`

Use the official IDLs in `raydium-io/raydium-idl`. Decode both outer and inner compiled instructions because a platform transaction can invoke Raydium through CPI.

Relevant instruction layouts from the official IDLs:

- LaunchLab `initialize`, `initialize_v2`, and `initialize_with_token_2022`: pool state account 5, base mint 6, quote mint 7.
- CPMM `initialize` and `initialize_with_permission`: pool state 3, token mints 4 and 5.
- CLMM `create_pool` and `create_customizable_pool`: pool state 2, token mints 3 and 4.

For standard WSS, a log notification lacks the full transaction, so decoding requires a confirmed `getTransaction` retry. LaserStream gRPC includes the transaction body and is the preferred low-latency path when the Helius plan supports it.

### StonkFun Schema

At the 2026-09-08 audit, the live StonkFun response contained 406 launchable quote assets:

- 23 `xstock`
- 7 `prestock`
- 19 `backpack` assets labeled `Sunrise`
- Other currencies, collectibles, leverage products, SOL assets, and custom mints

The existing parser tracks `xstock` and `prestock`. It expects a literal `sunrise` category, but the current API represents Sunrise as `category: "backpack"` with `categoryLabel: "Sunrise"`.

Do not classify every Sunrise entry as an equity. That group also contains non-equities such as DOGE, ARB, TAO, and LIT. Add a defensible issuer/category rule or explicit registry before admitting those mints to stock-only alerts.

## Recommended Implementation Order

1. Add a persistent equity registry to `state/solana.json` and `state/robinhood.json`.
2. On first boot, save the catalog baseline silently.
3. On later catalog refreshes, append `equity_catalog_added` records to internal NDJSON history.
4. Add a dedicated Solana history path such as `state/solana-events.ndjson`.
5. Subscribe to the three Raydium program IDs in both standard WSS and LaserStream modes.
6. Decode initialization instructions and append `raydium_stock_pair_created` only when either mint is in the verified equity registry.
7. Deduplicate with a stable key containing program, pool, stock mint, and paired mint.
8. Preserve source, signature, slot, pool, both mints, equity metadata, and observed-to-decision latency.
9. Keep Discord and Rick disabled. Review at least several hours of shadow history for false positives and missed known launches.
10. Add separate message types for `New Equity Listed` and `First Equity Pair`; only then enable Discord deliberately.

## Acceptance Criteria

- Existing catalog entries never alert during baseline initialization or restart.
- A newly added verified equity produces exactly one internal catalog event.
- A Raydium pool involving a verified equity produces exactly one internal first-pair event.
- Unrelated Raydium pools produce no stock event.
- CPI/inner instructions and versioned transaction loaded addresses decode correctly.
- Replay and reconnect do not duplicate events.
- Discord and Rick make zero requests while `DISCORD_ALERTS_ENABLED=0`.
- Base records only pools containing the official VVV CA and never posts to Discord during shadow mode.
- Budget telemetry outages remain visible and bounded without allowing unmonitored spend.
- Tests and syntax checks pass before deployment.

## Validation And Operations

Local validation:

```bash
npm ci
npm test
node --check src/realtime.mjs
node --check src/solana-realtime.mjs
node --check src/base-realtime.mjs
node --check src/watch.mjs
```

Production inspection:

```bash
ssh -i ~/.ssh/stock_pair_do root@167.172.131.186
systemctl status stock-pair-robinhood.service stock-pair-solana.service stock-pair-base.service
journalctl -u stock-pair-solana.service -f
cd /opt/stock-pair-alerts
npm run status -- --env /etc/stock-pair-alerts/env
```

When deploying shadow mode, confirm the generated environment contains:

```text
DISCORD_ALERTS_ENABLED=0
RICK_AUTOSCAN=0
```

## Current Cost Snapshot

Last successful telemetry snapshot:

- QuickNode: `$249/month`, 3,136,060 of 450,000,000 included credits used, no overage.
- Helius: free plan reported `$0`, 273,364 of 1,000,000 credits used.
- DigitalOcean: `$6/month` droplet.
- Budget estimator: `$255` fixed commitment against the `$1,000` weekly safety cap.

The configured Helius `$499` plan value is a fallback for a paid plan; provider telemetry reported the current subscription as free.

## Local Workspace Note

The local `reports/` directory contains replay and Discord-history artifacts and is intentionally untracked. Do not delete, reset, or commit it without confirming ownership and data-retention requirements.
