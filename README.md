# stock-pair-alerts

Discord alerts when Pons, Long.xyz, Flap, Pair Fund, or watched Solana launchpads get a new tokenized-stock quote asset.

The fastest mode is the realtime WebSocket listener. The GitHub Actions poller is still useful as a free fallback/reconciler, but scheduled Actions are not real time.

This is not a new-memecoin bot. The realtime listener watches onchain protocol events; the GitHub Actions fallback also checks the 01 / o1 catalog.

## What it watches

- Pons: `PairTokenApprovalUpdated(approved=true)` on `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`
- Long.xyz: first `LaunchCreated` on LongLauncher `0x22e99278308B393ea1260859B181AD7E78f5eeED` whose `numeraire` is a Robinhood stock token. A Robinhood catalog add is **not** a Long listing. Repeat launches against an already-seen stock are ignored.
- Flap: first `TokenQuoteSet` on the Flap router `0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09` whose quote asset is a Robinhood stock token. Repeat token/quote pairs are ignored.
- Pair Fund: first `CustomQuotePoolCreated` on the Pair launchpad `0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62` whose quote asset is a Robinhood stock token. Repeat project/quote/pool combinations are ignored.
- Pump.fun sentinel: Solana `logsSubscribe` on the Pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. It only fetches transactions with `Instruction: Create`, then alerts if the transaction references a known StonkFun Solana stock quote mint. Pump's public docs currently say new non-SOL quote support is announced but not live beyond native SOL, so this is a future-support detector.

Seen addresses are stored in `state/seen.json` so Discord does not repeat. First Pons run and the Long historical backfill are silent.

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

For day-one Solana performance, use Helius paid RPC/WebSocket endpoints for `SOLANA_RPC_HTTP_URL` and `SOLANA_RPC_WS_URL`. With a first-week cap of `$1000`, start on Helius Business (`$499/mo` at current pricing) instead of public RPC. Business includes `100M` credits and access to LaserStream gRPC, leaving roughly `$501` of headroom for extra credits or execution tips before the local cap trips.

Set these Helius values:

- `SOLANA_RPC_HTTP_URL`: `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY`
- `SOLANA_RPC_WS_URL`: `wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY`
- `HELIUS_API_KEY`: Helius API key for the Admin API.
- `HELIUS_PROJECT_ID`: Helius project id used by the Admin API usage endpoint.
- `REQUIRE_HELIUS_BUDGET_API=1`: fail closed if usage telemetry is not configured.
- `WEEKLY_BUDGET_USD=1000`: local weekly budget cap.
- `BUDGET_CHECK_MS=60000`: minimum time between runtime budget checks.

The Solana listener writes usage estimates into `state/budget.json`. If the weekly estimate reaches the cap, it writes `state/KILL_SWITCH` and exits with code `2`; while that file exists the listener refuses to restart. Delete the file only after intentionally raising/resetting the budget.

Also set the Helius dashboard Usage autoscaling limit so the account cannot spend past your intended ceiling. The local kill switch can stop this process from making more requests, but it cannot reverse a monthly plan charge or control other API keys using the same Helius account.

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
- `REQUIRE_QUICKNODE_ROBINHOOD`: set to `1` in production so a non-QuickNode Robinhood URL is rejected.
- `ALLOW_PUBLIC_ROBINHOOD_RPC`: set to `1` only for local smoke tests without a private Robinhood endpoint.
- `WATCH_PROTOCOLS`: comma-separated protocol ids. Defaults to `pons,long,flap,pair`.
- `SOLANA_RPC_HTTP_URL`: paid Solana HTTP RPC URL for fetching matching Pump create transactions. Required for production.
- `SOLANA_RPC_WS_URL`: paid Solana WebSocket RPC URL for Pump program logs. Required for production.
- `SOLANA_WATCH_PROTOCOLS`: comma-separated Solana protocol ids. Defaults to `pump`.
- `SOLANA_STOCK_REFRESH_MS`: how often to refresh the StonkFun stock quote-mint list. Defaults to `300000`.
- `HELIUS_API_KEY`: Helius key for Admin API budget checks.
- `HELIUS_PROJECT_ID`: Helius project id for Admin API budget checks.
- `REQUIRE_HELIUS_BUDGET_API`: set to `1` in production so the listener will not start without Helius usage telemetry.
- `HELIUS_MONTHLY_PLAN_USD`: monthly Helius plan cost included in local budget math. Defaults to `499`.
- `HELIUS_INCLUDED_CREDITS`: included monthly Helius credits. Defaults to `100000000`.
- `HELIUS_EXTRA_CREDIT_USD_PER_MILLION`: extra credit cost. Defaults to `5`.
- `WEEKLY_BUDGET_USD`: weekly local kill-switch threshold. Defaults to `1000`.
- `BUDGET_CHECK_MS`: minimum runtime interval between budget checks. Defaults to `60000`.
- `INTERESTING_SYMBOLS`: optional comma-separated ticker allowlist, for example `NVDA,TSLA,HOOD`.
- `IGNORE_SYMBOLS`: optional comma-separated ticker blocklist.
- `INTERESTING_ADDRESSES`: optional comma-separated token-address allowlist.
- `IGNORE_ADDRESSES`: optional comma-separated token-address blocklist.

If no allowlist is set, all new stock-token pairs from enabled protocols alert. The listeners store seen addresses in `state/seen.json`, reconnect on WebSocket drops, and refresh asset catalogs periodically.

For day-one performance, use a paid Solana RPC provider for `SOLANA_RPC_HTTP_URL` and `SOLANA_RPC_WS_URL`. The Solana listener intentionally does not default to public RPC; `ALLOW_PUBLIC_SOLANA_RPC=1` exists only for local smoke tests.

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
