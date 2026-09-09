# stock-pair-alerts

Low-latency monitoring for tokenized-stock launches on Robinhood Chain and Solana, plus new Base pools involving the official Venice VVV contract on supported venues.

The fastest mode is the realtime WebSocket listener. The GitHub Actions poller is still useful as a free fallback/reconciler, but scheduled Actions are not real time.

This is not a new-memecoin bot. The realtime listener watches onchain protocol events; the GitHub Actions fallback also checks the 01 / o1 catalog.

## What it watches

- Pons: `PairTokenApprovalUpdated(approved=true)` on `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`. Approvals are recorded internally and do not alert by default because they are catalog events, not trading momentum.
- Long.xyz: distinct `LaunchCreated` events on LongLauncher `0x22e99278308B393ea1260859B181AD7E78f5eeED` whose `numeraire` is a Robinhood stock token.
- Flap: first `TokenQuoteSet` on the Flap router `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09` whose quote asset is a Robinhood stock token.
- Pair Fund: current V2 `CanonicalProjectLaunched` events on the coordinator `0xf98b202fd8717b79f9c5e5dd67c2f9e640bbd25d`, including every Robinhood stock pool initialized in the launch receipt.
- Pump.fun sentinel: Pump `CreateEvent` data is decoded directly from `Create` and `CreateV2` stream logs. The new token's name, symbol, mint, and quote mint arrive without a `getTransaction` round trip. It alerts only when `quote_mint` is a tracked StonkFun Solana stock mint.
- Base VVV shadow listener: filtered pool-creation subscriptions for Uniswap V4, Uniswap V3, Uniswap V2, Aerodrome AMM, and all three official Aerodrome Slipstream factories. A pool qualifies only when one side is the official VVV CA `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf`; matching counterpart CAs and token metadata are written to internal history, never Discord.

Robinhood launches are registered as candidates instead of alerting immediately. The listener subscribes to Uniswap v4 PoolManager swaps and alerts when a candidate reaches one of these default signals:

- At least 5 unique buyers and $1,500 of buy volume in the first 60 seconds, including 2 new wallets after the initial buy block and buys spanning at least 3 blocks.
- At least $5,000 of buy volume from at least 2 buyers in the first 60 seconds, which remains the fast-track signal.
- Same-block buyer concentration is shown as a coordination risk indicator but cannot qualify a token by itself.
- At least 8 unique buyers with the same cross-block follow-through when Robinhood's USD quote endpoint is temporarily unavailable.
- An estimated $20k, $50k, or $100k FDV, gated by the organic follow-through or fast-track volume rule so launch bundles and dust swaps cannot trigger it alone.

The first qualified signal creates one Discord message and optionally triggers Rick once. Later FDV milestones edit that message in place. Each alert displays the project ticker and CA, paired stock, buyer count, buy volume, bundle indicators, estimated FDV when available, and signal transaction.

Seen addresses are stored on disk so Discord does not repeat. First Pons run and the Long historical backfill are silent.

The realtime services use separate runtime state files:

- `state/robinhood.json`: Robinhood Chain seen pairs.
- `state/robinhood-events.ndjson`: append-only Robinhood candidate, normalized trade, qualification, and milestone history for later tuning.
- `state/solana.json`: Solana/Pump seen stock-mint launches.
- `state/base.json`: deduplicated Base pools involving the official VVV contract.
- `state/base-events.ndjson`: append-only Base VVV pool creation, removal, and metadata history.
- `state/alert-cap.json`: shared rolling token-alert reservations across both realtime services.
- `state/alert-events.ndjson`: append-only history of allowed and cap-suppressed token alerts.
- `state/budget.json`: shared provider budget telemetry.
- `state/KILL_SWITCH`: manual or automatic stop file shared by every realtime listener.

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

To collect Base/VVV pool launches in shadow mode, run a third process with a paid Base endpoint:

```bash
npm run base-realtime
```

### Base VVV production setup

The Base listener uses server-side topic filters rather than polling. `pending-logs` subscribes to Base Flashblocks `pendingLogs` for roughly 200 ms preconfirmation updates; `standard-wss` uses sealed WebSocket logs. QuickNode documents Flashblocks support on existing Base endpoints, but the selected endpoint must still be tested with the configured subscription mode before the service gate is enabled.

Set:

- `BASE_RPC_WS_URL`: paid Base Mainnet WebSocket endpoint.
- `BASE_RPC_HTTP_URL`: matching paid HTTP endpoint used for chain verification, reconnect backfill, and token metadata.
- `BASE_STREAM_MODE=pending-logs`: preferred low-latency mode when the provider supports Base Flashblocks. Use `standard-wss` otherwise.
- `BASE_WATCH_PROTOCOLS=uniswap-v4,uniswap-v3,uniswap-v2,aerodrome,aerodrome-slipstream`: enabled Base venues.
- `REQUIRE_QUICKNODE_BASE=1`: reject non-QuickNode endpoints in the current production configuration.
- `ALLOW_PUBLIC_BASE_RPC=0`: fail closed when the paid endpoint is missing.
- `BASE_LISTENER_ENABLED=1`: allows the deployment's gated systemd service to start. It defaults to `0`.

Base is intentionally history-only: it has no Discord or Rick delivery path. The first 100,000 blocks are backfilled into internal state, reconnects replay a 32-block overlap, and stable pool keys suppress duplicates.

Base requests are included in the same account-level QuickNode telemetry already enforced by the shared budget guard. Do not add a second fixed plan amount unless the QuickNode dashboard actually creates a separate paid subscription; if it does, update `QUICKNODE_MONTHLY_PLAN_USD` to the combined commitment before enabling Base.

Validate the decoder and historical coverage without opening a WebSocket:

```bash
BASE_RPC_HTTP_URL=https://YOUR-PAID-BASE-ENDPOINT npm run base-backfill
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

All realtime listeners share usage estimates in `state/budget.json`. The estimate includes QuickNode account usage and paid invoices from the trailing seven days, the configured DigitalOcean commitment and reported month-to-date usage, the Helius plan and overage estimate, and any manually recorded local spend. This makes an annual QuickNode invoice count at its full paid amount instead of its advertised monthly equivalent. If the Helius Admin API reports the Free plan, its plan estimate is forced to `$0`. If the total reaches the cap, any listener writes `state/KILL_SWITCH` and exits with code `2`; every service refuses to restart while that file exists. Delete the file only after intentionally raising or resetting the budget.

`DIGITALOCEAN_MONTHLY_HARD_CAP_USD` is a local enforcement ceiling: all listeners fail closed if the configured commitment exceeds it or the Billing API reports month-to-date account usage at the cap. The fixed-size droplet limits its base compute price, but DigitalOcean does not provide an account-level spend hard cap. Stopping these processes also does not stop Droplet billing, so this cannot guarantee that charges created outside this deployment, such as extra resources, backups, or bandwidth overages, stay below the ceiling.

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
- `REQUIRE_QUICKNODE_BUDGET_API=1`: stop realtime listeners when QuickNode usage cannot be verified.

For sniper-style latency, deploy the bot in the region closest to the QuickNode endpoint and verify p95/p99 WebSocket log latency during market-open bursts. Avoid the public endpoint except for local smoke tests.

Environment variables:

- `DISCORD_WEBHOOK_URL`: Discord webhook to post alerts.
- `DISCORD_WEBHOOK_URL_2`: optional second Discord webhook.
- `DISCORD_ALERTS_ENABLED`: explicit Discord delivery switch. Defaults off; set to `1` only after shadow verification.
- `REALTIME_RPC_WS_URL`: QuickNode Robinhood Chain WebSocket RPC URL. Required for production.
- `REALTIME_RPC_HTTP_URL`: optional QuickNode HTTP URL. When omitted it is derived from the WebSocket URL and used only for reconnect backfill, ERC-20 metadata, and Pair launch receipts.
- `REQUIRE_QUICKNODE_ROBINHOOD`: set to `1` in production so a non-QuickNode Robinhood URL is rejected.
- `ALLOW_PUBLIC_ROBINHOOD_RPC`: set to `1` only for local smoke tests without a private Robinhood endpoint.
- `BASE_LISTENER_ENABLED`: deployment gate for the Base systemd service. Defaults to `0`.
- `BASE_RPC_WS_URL`: paid Base WebSocket URL. Required by the Base process.
- `BASE_RPC_HTTP_URL`: paid Base HTTP URL for sealed backfill and metadata.
- `BASE_STREAM_MODE`: `pending-logs` for Flashblocks preconfirmations or `standard-wss` for sealed logs.
- `BASE_WATCH_PROTOCOLS`: Base protocol ids; defaults to all supported venues.
- `BASE_BOOTSTRAP_LOOKBACK_BLOCKS`: first-run Base history window. Defaults to `100000`.
- `BASE_BACKFILL_OVERLAP_BLOCKS`: reconnect overlap. Defaults to `32`.
- `BASE_BACKFILL_CHUNK`: maximum blocks per Base `eth_getLogs` request. Defaults to `2000`.
- `BASE_RPC_MIN_INTERVAL_MS`: optional HTTP RPC throttle for backfills. Defaults to `0` on paid endpoints.
- `BASE_STATE_PATH`: optional Base state path override.
- `BASE_HISTORY_PATH`: optional append-only Base history path override.
- `REQUIRE_QUICKNODE_BASE`: require a QuickNode-hosted Base endpoint.
- `ALLOW_PUBLIC_BASE_RPC`: local smoke-test escape hatch; keep `0` in production.
- `WATCH_PROTOCOLS`: comma-separated protocol ids. Defaults to `pons,long,flap,pair`.
- `PONS_APPROVAL_ALERTS`: set to `1` to restore immediate Pons approval alerts. Defaults to `0`.
- `MOMENTUM_WINDOW_MS`: early-signal window after launch. Defaults to `60000`.
- `MOMENTUM_TRACKING_MS`: how long a pool remains active for milestone tracking. Defaults to `3600000`.
- `MOMENTUM_MIN_UNIQUE_BUYERS`: buyers required alongside minimum USD volume. Defaults to `5`.
- `MOMENTUM_MIN_BUY_VOLUME_USD`: early momentum and milestone volume gate. Defaults to `1500`.
- `MOMENTUM_MIN_BUY_BLOCKS`: distinct buy blocks required for organic follow-through. Defaults to `3`.
- `MOMENTUM_MIN_FOLLOW_THROUGH_BUYERS`: new buyers after the initial buy block. Defaults to `2`.
- `MOMENTUM_WHALE_BUY_VOLUME_USD`: standalone early buy-volume trigger. Defaults to `5000`.
- `MOMENTUM_MIN_BUNDLE_BUYERS`: same-block unique-buyer threshold displayed as a risk indicator. Defaults to `3`.
- `MOMENTUM_WALLET_FALLBACK_BUYERS`: wallet trigger used only when the USD price is unavailable. Defaults to `8`.
- `MOMENTUM_SUBSCRIPTION_REFRESH_MS`: candidate expiry and pool-subscription reconciliation interval. Defaults to `30000`.
- `MOMENTUM_HISTORY_PATH`: optional override for the append-only NDJSON history path.
- `ALERT_CAP_MAX`: maximum token alerts shared by Robinhood and Solana during the rolling window. Defaults to `10`.
- `ALERT_CAP_WINDOW_MS`: rolling Discord token-alert window. Defaults to `28800000` (8 hours).
- `ALERT_CAP_STATE_PATH`: optional override for the shared alert-cap ledger.
- `ALERT_CAP_HISTORY_PATH`: optional override for the allowed and suppressed alert history.
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
- `DIGITALOCEAN_MONTHLY_HARD_CAP_USD`: maximum configured DigitalOcean monthly commitment; all realtime listeners stop if it is exceeded.
- `DIGITALOCEAN_BILLING_TOKEN`: DigitalOcean token restricted to `billing:read`.
- `REQUIRE_DIGITALOCEAN_BUDGET_API`: stop realtime listeners when DigitalOcean usage cannot be verified.
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

Required when enabling the Base service:

- `QUICKNODE_BASE_HTTP_URL`: paid QuickNode Base HTTP endpoint.
- `QUICKNODE_BASE_WS_URL`: paid QuickNode Base WebSocket endpoint with support for the selected stream mode.

Optional GitHub Actions secrets:

- `DISCORD_WEBHOOK_URL_2`
- `INTERESTING_SYMBOLS`
- `IGNORE_SYMBOLS`
- `INTERESTING_ADDRESSES`
- `IGNORE_ADDRESSES`

Run **Deploy DigitalOcean realtime listeners** from GitHub Actions after those secrets are set. Use `restart_services=false` to sync and test without starting the listeners. Set the `BASE_LISTENER_ENABLED` repository variable to `1` only after the paid Base endpoints and subscription mode are verified; Base remains Discord-silent either way.
