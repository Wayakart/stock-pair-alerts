# stock-pair-alerts

High-signal Discord alerts when Long.xyz, Flap, Pair Fund, or watched Solana launchpads show meaningful activity around a tokenized-stock pair.

The fastest mode is the realtime WebSocket listener. The GitHub Actions poller is still useful as a free fallback/reconciler, but scheduled Actions are not real time.

This is not a new-memecoin bot. The realtime listener watches onchain protocol events; the GitHub Actions fallback also checks the 01 / o1 catalog.

## What it watches

- Pons: `PairTokenApprovalUpdated(approved=true)` on `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`. Approvals are recorded internally and do not alert by default because they are catalog events, not trading momentum.
- Long.xyz: distinct `LaunchCreated` events on LongLauncher `0x22e99278308B393ea1260859B181AD7E78f5eeED` whose `numeraire` is a Robinhood stock token.
- Flap: first `TokenQuoteSet` on the Flap router `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09` whose quote asset is a Robinhood stock token.
- Pair Fund: current V2 `CanonicalProjectLaunched` events on the coordinator `0xf98b202fd8717b79f9c5e5dd67c2f9e640bbd25d`, including every Robinhood stock pool initialized in the launch receipt.
- Pump.fun sentinel: Pump `CreateEvent` data is decoded directly from `Create` and `CreateV2` stream logs. The new token's name, symbol, mint, and quote mint arrive without a `getTransaction` round trip. It alerts only when `quote_mint` is a tracked StonkFun Solana stock mint.

Robinhood launches are registered as candidates instead of alerting immediately. The listener subscribes to Uniswap v4 PoolManager swaps and alerts when a candidate reaches one of these default signals:

- At least 3 unique buyers and $1,000 of buy volume in the first 60 seconds.
- At least $5,000 of buy volume in the first 60 seconds.
- At least 3 unique buyers in one block, shown as a coordination risk indicator.
- At least 5 unique buyers in 60 seconds when Robinhood's USD quote endpoint is temporarily unavailable.
- An estimated $20k, $50k, or $100k FDV, gated by at least 3 buyers or $1,000 of buy volume so dust swaps cannot trigger it alone.

The first qualified signal creates one Discord message and optionally triggers Rick once. Later FDV milestones edit that message in place. Each alert displays the project ticker and CA, paired stock, buyer count, buy volume, bundle indicators, estimated FDV when available, and signal transaction.

Seen addresses are stored on disk so Discord does not repeat. First Pons run and the Long historical backfill are silent.

The realtime services use separate runtime state files:

- `state/robinhood.json`: Robinhood Chain seen pairs.
- `state/robinhood-events.ndjson`: append-only Robinhood candidate, normalized trade, qualification, and milestone history for later tuning.
- `state/solana.json`: Solana/Pump seen stock-mint launches.
- `state/budget.json`: Helius budget telemetry.
- `state/KILL_SWITCH`: manual or automatic stop file for the Solana budget guard.

## Realtime setup

Run this on an always-on host, not GitHub Actions:

```bash
npm install
npm run realtime
```

To also watch Solana Pump launches for stock quote-mint support, run a second process:

```bash
npm run solana-realtime
```

### Helius production setup

For day-one Solana performance, use Helius paid RPC/WebSocket endpoints for `SOLANA_RPC_HTTP_URL` and `SOLANA_RPC_WS_URL`. Mainnet LaserStream gRPC requires Helius Business or Professional access. Keep the configured plan cost and credit allowance aligned with the selected dashboard plan before switching `SOLANA_STREAM_MODE` to `laserstream-grpc`.

Set these Helius values:

- `SOLANA_RPC_HTTP_URL`: `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY`
- `SOLANA_RPC_WS_URL`: `wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY`
- `SOLANA_STREAM_MODE=laserstream-grpc`: use the native Helius LaserStream SDK with automatic reconnect and slot replay. Mainnet access requires a Helius Business or Professional plan.
- `SOLANA_LASERSTREAM_ENDPOINT=https://laserstream-mainnet-ewr.helius-rpc.com`: Newark endpoint, closest to the NYC1 droplet.
- `HELIUS_API_KEY`: Helius API key for the Admin API.
- `HELIUS_PROJECT_ID`: Helius project id used by the Admin API usage endpoint.
- `REQUIRE_HELIUS_BUDGET_API=1`: fail closed if usage telemetry is not configured.
- `WEEKLY_BUDGET_USD=1000`: local weekly budget cap.
- `BUDGET_CHECK_MS=60000`: minimum time between runtime budget checks.
- `HEARTBEAT_MS=60000`: service heartbeat log interval.
- `STALE_CONNECTION_MS=180000`: stale WebSocket warning threshold.
- `DRY_RUN_DECISIONS=1`: log simulated buy decisions before Discord notification.
- `DRY_RUN_MAX_USD=100`: simulated max buy size.
- `DRY_RUN_MAX_SLIPPAGE_BPS=500`: simulated max slippage.
- `QUICKNODE_MONTHLY_PLAN_USD=249`: QuickNode monthly plan assumption used by status projections.
- `QUICKNODE_ADMIN_API_KEY`: paid-plan Admin API key used to read current credits and overages.
- `REQUIRE_QUICKNODE_BUDGET_API=1`: fail closed if QuickNode usage telemetry is unavailable.
- `DIGITALOCEAN_MONTHLY_USD=6`: DigitalOcean monthly droplet assumption used by status projections.
- `DIGITALOCEAN_MONTHLY_HARD_CAP_USD=6`: fail-closed ceiling for the configured DigitalOcean monthly commitment.
- `DIGITALOCEAN_BILLING_TOKEN`: read-only `billing:read` token used to read month-to-date account usage.
- `REQUIRE_DIGITALOCEAN_BUDGET_API=1`: fail closed if DigitalOcean billing telemetry is unavailable.

Both realtime listeners share usage estimates in `state/budget.json`. The estimate includes QuickNode plan usage and paid invoices from the trailing seven days, the configured DigitalOcean commitment and reported month-to-date usage, the Helius plan and overage estimate, and any manually recorded local spend. This makes an annual QuickNode invoice count at its full paid amount instead of its advertised monthly equivalent. If the Helius Admin API reports the Free plan, its plan estimate is forced to `$0`. If the total reaches the cap, either listener writes `state/KILL_SWITCH` and exits with code `2`; both services refuse to restart while that file exists. Delete the file only after intentionally raising or resetting the budget.

`DIGITALOCEAN_MONTHLY_HARD_CAP_USD` is a local enforcement ceiling: both listeners fail closed if the configured commitment exceeds it or the Billing API reports month-to-date account usage at the cap. The fixed-size droplet limits its base compute price, but DigitalOcean does not provide an account-level spend hard cap. Stopping these processes also does not stop Droplet billing, so this cannot guarantee that charges created outside this deployment, such as extra resources, backups, or bandwidth overages, stay below the ceiling.

Also set the Helius dashboard Usage autoscaling limit so the account cannot spend past your intended ceiling. The local kill switch can stop this process from making more requests, but it cannot reverse a monthly plan charge or control other API keys using the same Helius account.

Budget warnings are sent at 80%, 90%, and 95% of the weekly cap, once per threshold per budget week.

### QuickNode Robinhood production setup

Robinhood runs on QuickNode in production. Create a QuickNode Robinhood Chain Mainnet endpoint, copy its WebSocket URL, and set it as `REALTIME_RPC_WS_URL`. The realtime listener keeps one subscription for enabled launch protocols and a second, dynamically replaced subscription whose topic filter contains only active candidate pool IDs. The previous pool subscription remains active until QuickNode acknowledges its replacement, then a filtered overlap backfill closes the handoff gap.

Set:

- `REALTIME_RPC_WS_URL`: QuickNode Robinhood Chain WebSocket endpoint, for example `wss://YOUR-ENDPOINT.robinhood-mainnet.quiknode.pro/YOUR-TOKEN/`.
- `REQUIRE_QUICKNODE_ROBINHOOD=1`: fail closed if the configured Robinhood endpoint is not a QuickNode URL.
- `ALLOW_PUBLIC_ROBINHOOD_RPC=0`: keep the listener fail-closed if the private URL is missing.
- `WATCH_PROTOCOLS=pons,long,flap,pair`: enabled Robinhood protocols.
- `QUICKNODE_ADMIN_API_KEY`: separate QuickNode Admin API key for usage and overage checks; the endpoint auth token is not sufficient.
- `REQUIRE_QUICKNODE_BUDGET_API=1`: stop both listeners when QuickNode usage cannot be verified.

For sniper-style latency, deploy the bot in the region closest to the QuickNode endpoint and verify p95/p99 WebSocket log latency during market-open bursts. Avoid the public endpoint except for local smoke tests.

Environment variables:

- `DISCORD_WEBHOOK_URL`: Discord webhook to post alerts.
- `DISCORD_WEBHOOK_URL_2`: optional second Discord webhook.
- `REALTIME_RPC_WS_URL`: QuickNode Robinhood Chain WebSocket RPC URL. Required for production.
- `REALTIME_RPC_HTTP_URL`: optional QuickNode HTTP URL. When omitted it is derived from the WebSocket URL and used only for reconnect backfill, ERC-20 metadata, and Pair launch receipts.
- `REQUIRE_QUICKNODE_ROBINHOOD`: set to `1` in production so a non-QuickNode Robinhood URL is rejected.
- `ALLOW_PUBLIC_ROBINHOOD_RPC`: set to `1` only for local smoke tests without a private Robinhood endpoint.
- `WATCH_PROTOCOLS`: comma-separated protocol ids. Defaults to `pons,long,flap,pair`.
- `PONS_APPROVAL_ALERTS`: set to `1` to restore immediate Pons approval alerts. Defaults to `0`.
- `MOMENTUM_WINDOW_MS`: early-signal window after launch. Defaults to `60000`.
- `MOMENTUM_TRACKING_MS`: how long a pool remains active for milestone tracking. Defaults to `3600000`.
- `MOMENTUM_MIN_UNIQUE_BUYERS`: buyers required alongside minimum USD volume. Defaults to `3`.
- `MOMENTUM_MIN_BUY_VOLUME_USD`: early momentum and milestone volume gate. Defaults to `1000`.
- `MOMENTUM_WHALE_BUY_VOLUME_USD`: standalone early buy-volume trigger. Defaults to `5000`.
- `MOMENTUM_MIN_BUNDLE_BUYERS`: same-block unique-buyer trigger. Defaults to `3`.
- `MOMENTUM_WALLET_FALLBACK_BUYERS`: wallet trigger used only when the USD price is unavailable. Defaults to `5`.
- `MOMENTUM_SUBSCRIPTION_REFRESH_MS`: candidate expiry and pool-subscription reconciliation interval. Defaults to `30000`.
- `MOMENTUM_HISTORY_PATH`: optional override for the append-only NDJSON history path.
- `SOLANA_RPC_HTTP_URL`: paid Solana HTTP RPC URL used for provider access and operational recovery. Pump create alerts decode directly from stream logs on the hot path.
- `SOLANA_RPC_WS_URL`: paid Solana WebSocket RPC URL for Pump program logs. Required for production.
- `SOLANA_WATCH_PROTOCOLS`: comma-separated Solana protocol ids. Defaults to `pump`.
- `SOLANA_STREAM_MODE`: `standard-wss` or `laserstream-grpc`. gRPC is the production path with replay; standard WebSocket remains available while LaserStream access is pending.
- `SOLANA_LASERSTREAM_ENDPOINT`: Helius LaserStream regional endpoint. Defaults to Newark (`ewr`).
- `SOLANA_REPLAY_OVERLAP_SLOTS`: persisted-slot overlap used when starting gRPC replay. Defaults to `128`.
- `SOLANA_STOCK_REFRESH_MS`: how often to refresh the StonkFun stock quote-mint list. Defaults to `300000`.
- `HELIUS_API_KEY`: Helius key for Admin API budget checks.
- `HELIUS_PROJECT_ID`: Helius project id for Admin API budget checks.
- `REQUIRE_HELIUS_BUDGET_API`: set to `1` in production so the listener will not start without Helius usage telemetry.
- `HELIUS_MONTHLY_PLAN_USD`: monthly Helius plan cost included in local budget math. Defaults to `499`; a live Admin API response identifying the Free plan overrides it to `0`.
- `HELIUS_INCLUDED_CREDITS`: included monthly Helius credits. Defaults to `100000000`.
- `HELIUS_EXTRA_CREDIT_USD_PER_MILLION`: extra credit cost. Defaults to `5`.
- `WEEKLY_BUDGET_USD`: weekly local kill-switch threshold. Defaults to `1000`.
- `BUDGET_CHECK_MS`: minimum runtime interval between budget checks. Defaults to `60000`.
- `QUICKNODE_INCLUDED_CREDITS`: credits included in the selected QuickNode plan. Defaults to `450000000`.
- `QUICKNODE_EXTRA_CREDIT_USD_PER_MILLION`: overage price used for QuickNode spend estimates. Defaults to `0.56`.
- `DIGITALOCEAN_MONTHLY_USD`: expected monthly DigitalOcean commitment included in budget estimates.
- `DIGITALOCEAN_MONTHLY_HARD_CAP_USD`: maximum configured DigitalOcean monthly commitment; both realtime listeners stop if it is exceeded.
- `DIGITALOCEAN_BILLING_TOKEN`: DigitalOcean token restricted to `billing:read`.
- `REQUIRE_DIGITALOCEAN_BUDGET_API`: stop both listeners when DigitalOcean usage cannot be verified.
- `INTERESTING_SYMBOLS`: optional comma-separated ticker allowlist, for example `NVDA,TSLA,HOOD`.
- `IGNORE_SYMBOLS`: optional comma-separated ticker blocklist.
- `INTERESTING_ADDRESSES`: optional comma-separated token-address allowlist.
- `IGNORE_ADDRESSES`: optional comma-separated token-address blocklist.
- `EVM_BOOTSTRAP_LOOKBACK_BLOCKS`: silent first-run lookback for newly added Robinhood protocols. Defaults to `100000`.
- `EVM_BACKFILL_OVERLAP_BLOCKS`: overlap applied to every reconnect backfill. Defaults to `32`.
- `RICK_AUTOSCAN`: when `1`, puts `.x <project CA>` or `.pf <project mint>` in webhook message content. It defaults to `0`; enable it only after Rick's operator approves automated webhook triggers.

If no allowlist is set, all new stock-token pairs from enabled protocols alert. The Robinhood listener subscribes first and then replays from persisted block checkpoints through the same ordered deduplication path. LaserStream gRPC persists the latest processed Solana slot and automatically replays after reconnects.

For day-one performance, use a paid Solana RPC provider for `SOLANA_RPC_HTTP_URL` and `SOLANA_RPC_WS_URL`. The Solana listener intentionally does not default to public RPC; `ALLOW_PUBLIC_SOLANA_RPC=1` exists only for local smoke tests.

## Performance operations

Realtime alerts are not the same thing as execution. The app now separates the latency-sensitive detection path from human notifications:

- Provider event received.
- Protocol-specific launch registration and Uniswap v4 swap aggregation.
- Buyer, USD buy-volume, bundle, and estimated-FDV classification.
- Dry-run trading decision logged as `dry_run_decision`.
- One Discord notification sent for a qualified signal; later FDV milestones edit it in place.

Latency traces are logged as structured JSON events named `latency`. Heartbeats are logged as `heartbeat`, and stale WebSocket warnings are logged and sent to Discord.

Run provider benchmarks from the droplet:

```bash
cd /opt/stock-pair-alerts
npm run benchmark -- --env /etc/stock-pair-alerts/env --samples 20
```

The benchmark measures QuickNode Robinhood WebSocket request latency, Helius HTTP RPC latency, and Helius LaserStream WebSocket subscription acknowledgment latency. Use p95/p99 behavior from the actual droplet region to decide whether to move regions or upgrade provider plans.

Run current status and spend projection:

```bash
cd /opt/stock-pair-alerts
npm run status -- --env /etc/stock-pair-alerts/env
```

Replay an exact historical Robinhood window through the current momentum rules without posting to Discord or triggering Rick:

```bash
EVM_REPLAY_RPC_HTTP_URL=https://YOUR-ENDPOINT npm run replay:robinhood -- \
  2026-09-07T04:40:46.177Z 2026-09-07T12:40:46.177Z \
  reports/robinhood-signal-replay.json
```

The replay report includes every candidate pool, normalized trade, first qualification, milestone, and aggregate noise-reduction totals. `REPLAY_RPC_MIN_INTERVAL_MS` defaults to `100` to protect the endpoint from metadata bursts.

Additional protocols should be added only after their contract address, event signature, and "new interesting pair" semantics are verified. Pools.trade, Bags.fm, trench.today, hood.fun, Bankr, Virtuals, and Clanker are candidates, but they need protocol-specific confirmation before enabling alerts.

## GitHub Actions fallback setup

1. Add an Actions secret named DISCORD_WEBHOOK_URL:
   https://github.com/Wayakart/stock-pair-alerts/settings/secrets/actions
   Optional secrets: DISCORD_WEBHOOK_URL_2, RPC_URL
2. GitHub's connector cannot create workflow files. Create `.github/workflows/watch.yml` from the template in SETUP.md.
   Shortcut: https://github.com/Wayakart/stock-pair-alerts/new/main?filename=.github/workflows/watch.yml
3. Actions then Run workflow. First run is silent. Then run once with test_ping checked.

Alchemy (optional, still free): https://www.alchemy.com — Robinhood Chain app, then put the HTTPS URL in RPC_URL.

## DigitalOcean deploy workflow

The deploy workflow writes GitHub secrets into `/etc/stock-pair-alerts/env` on the droplet, syncs the repo to `/opt/stock-pair-alerts`, runs tests, and restarts the realtime services.

Required GitHub Actions secrets:

- `DO_HOST`: DigitalOcean droplet IP.
- `DO_SSH_PRIVATE_KEY`: SSH private key accepted by the droplet.
- `DISCORD_WEBHOOK_URL`: Discord alert webhook.
- `QUICKNODE_ROBINHOOD_WS_URL`: QuickNode Robinhood Chain WebSocket endpoint.
- `HELIUS_RPC_HTTP_URL`: Helius Solana HTTP RPC URL.
- `HELIUS_RPC_WS_URL`: Helius Solana WebSocket RPC URL.
- `HELIUS_API_KEY`: Helius key for Admin API budget checks.
- `HELIUS_PROJECT_ID`: Helius project id for Admin API budget checks.

Optional GitHub Actions secrets:

- `DISCORD_WEBHOOK_URL_2`
- `INTERESTING_SYMBOLS`
- `IGNORE_SYMBOLS`
- `INTERESTING_ADDRESSES`
- `IGNORE_ADDRESSES`

Run **Deploy DigitalOcean realtime listeners** from GitHub Actions after those secrets are set. Use `restart_services=false` to sync and test without starting the listeners.
