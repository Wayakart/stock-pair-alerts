# stock-pair-alerts

Free GitHub Actions poller. Posts to Discord when Pons or Long.xyz get a new tokenized-stock quote asset on Robinhood Chain (4663).

This is not a new-memecoin bot. 01 / o1 is not watched.

## What it watches

- Pons: PairTokenApprovalUpdated(approved=true) on 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
- Long.xyz: new active stock on GET https://api.robinhood.com/rhj/assets

Polls every 10 minutes. First run only snapshots, no historical spam.

## Setup

1. Add an Actions secret named DISCORD_WEBHOOK_URL:
   https://github.com/Wayakart/stock-pair-alerts/settings/secrets/actions
   Optional secrets: DISCORD_WEBHOOK_URL_2, RPC_URL
2. GitHub's connector cannot create workflow files. Create `.github/workflows/watch.yml` from the template in SETUP.md.
   Shortcut: https://github.com/Wayakart/stock-pair-alerts/new/main?filename=.github/workflows/watch.yml
3. Actions then Run workflow. First run is silent. Then run once with test_ping checked.

Alchemy (optional, still free): https://www.alchemy.com — Robinhood Chain app, then put the HTTPS URL in RPC_URL.
