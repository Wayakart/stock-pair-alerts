# stock-pair-alerts

Discord alerts when Pons, Long.xyz, Flap, Pair Fund, or watched Solana launchpads get a new tokenized-stock quote asset.

The fastest mode is the realtime WebSocket listener. The GitHub Actions poller is still useful as a free fallback/reconciler, but scheduled Actions are not real time.

This is not a new-memecoin bot. The realtime listener watches onchain protocol events; the GitHub Actions fallback also checks the 01 / o1 catalog.

## What it watches

- Pons: `PairTokenApprovalUpdated(approved=true)` on `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- Long.xyz: every distinct `LaunchCreated` on LongLauncher `0x22e99278308B393ea1260859B181AD7E78f5eeED` whose `numeraire` is a Robinhood stock token. Launches are deduplicated by transaction, so multiple projects paired with the same stock still alert.
- Flap: first `TokenQuoteSet` on the Flap router `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09` whose quote asset is a Robinhood stock token. Repeat token/quote pairs are ignored.
- Pair Fund: current V2 `CanonicalProjectLaunched` events on the coordinator `0xf98b202fd8717b79f9c5e5dd67c2f9e640bbd25d`. The listener reads all `CanonicalPoolLaunched` events from the same receipt and emits one project alert containing every Robinhood stock quote.
- Pump.fun sentinel: Pump `CreateEvent` data is decoded directly from `Create` and `CreateV2` stream logs. The new token's name, symbol, mint, and quote mint arrive without a `getTransaction` round trip. It alerts only when `quote_mint` is a tracked StonkFun Solana stock mint.

Every launch alert displays the new project token first: ticker, contract address or mint, paired stock ticker(s), quote addresses, transaction, and a copyable Rick command. The paired stock address is never used as the project CA.

Seen addresses are stored on disk so Discord does not repeat. First Pons run and the Long historical backfill are silent.

The realtime services use separate runtime state files:

- `state/robinhood.json`: Robinhood Chain seen pairs.
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
- `DIGITALOCEAN_MONTHLY_USD=6`: DigitalOcean monthly droplet assumption used by status projections.
- `DIGITALOCEAN_MONTHLY_HARD_CAP_USD=6`: fail-closed ceiling for the configured DigitalOcean monthly commitment.

Both realtime listeners share usage estimates in `state/budget.json`. The estimate includes the configured monthly QuickNode and DigitalOcean commitments, the Helius plan and overage estimate, and any manually recorded local spend. If the Helius Admin API reports the Free plan, its plan estimate is forced to `$0`. If the total reaches the cap, either listener writes `state/KILL_SWITCH` and exits with code `2`; both services refuse to restart while that file exists. Delete the file only after intentionally raising or resetting the budget.

`DIGITALOCEAN_MONTHLY_HARD_CAP_USD` is a local configuration ceiling: both listeners fail closed if `DIGITALOCEAN_MONTHLY_USD` exceeds it. The fixed-size droplet limits its base compute price, but DigitalOcean does not provide an account-level spend hard cap. This control cannot prevent charges created outside this deployment, such as extra resources, backups, or bandwidth overages.

Also set the Helius dashboard Usage autoscaling limit so the account cannot spend past your intended ceiling. The local kill switch can stop this process from making more requests, but it cannot reverse a monthly plan charge or control other API keys using the same Helius account.

Budget warnings are sent at 80%, 90%, and 95% of the weekly cap, once per threshold per budget week.

### QuickNode Robinhood production setup

Robinhood runs on QuickNode in production. Create a QuickNode Robinhood Chain Mainnet endpoint, copy its WebSocket URL, and set it as `REALTIME_RPC_WS_URL`. The realtime listener subscribes to all enabled protocol logs in one EVM `eth_subscribe` filter and routes matching logs locally, so it receives events as the RPC pushes them instead of polling blocks.

Set:

- `REALTIME_RPC_WS_URL`: QuickNode Robinhood Chain WebSocket endpoint, for example `wss://YOUR-ENDPOINT.robinhood-mainnet.quiknode.pro/YOUR-TOKEN/`.
- `REQUIRE_QUICKNODE_ROBINHOOD=1`: fail closed if the configured Robinhood endpoint is not a QuickNode URL.
- `ALLOW_PUBLIC_ROBINHOOD_RPC=0`: keep the listener fail-closed if the private URL is missing.
- `WATCH_PROTOCOLS=pons,long,flap,pair`: enabled Robinhood protocols.

For sniper-style latency, deploy the bot in the region closest to the QuickNode endpoint and verify p95/p99 WebSocket log latency during market-open bursts. Avoid the public endpoint except for local smoke tests.

Environment variables:

- `DISCORD_WEBHOOK_URL`: Discord webhook to post alerts.
- `DISCORD_WEBHOOK_URL_2`: optional second Discord webhook.
- `REALTIME_RPC_WS_URL`: QuickNode Robinhood Chain WebSocket RPC URL. Required for production.
- `REALTIME_RPC_HTTP_URL`: optional QuickNode HTTP URL. When omitted it is derived from the WebSocket URL and used only for reconnect backfill, ERC-20 metadata, and Pair launch receipts.
- `REQUIRE_QUICKNODE_ROBINHOOD`: set to `1` in production so a non-QuickNode Robinhood URL is rejected.
- `ALLOW_PUBLIC_ROBINHOOD_RPC`: set to `1` only for local smoke tests without a private Robinhood endpoint.
- `WATCH_PROTOCOLS`: comma-separated protocol ids. Defaults to `pons,long,flap,pair`.
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
- `DIGITALOCEAN_MONTHLY_USD`: expected monthly DigitalOcean commitment included in budget estimates.
- `DIGITALOCEAN_MONTHLY_HARD_CAP_USD`: maximum configured DigitalOcean monthly commitment; both realtime listeners stop if it is exceeded.
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
- Protocol-specific decode/classification.
- Dry-run trading decision logged as `dry_run_decision`.
- Discord notification sent for human visibility.

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
