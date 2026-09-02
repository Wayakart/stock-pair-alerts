Create this file as `.github/workflows/watch.yml`.

GitHub's connector cannot write workflow files, so this has to be added in the GitHub UI:
https://github.com/Wayakart/stock-pair-alerts/new/main?filename=.github/workflows/watch.yml

Use the YAML from the chat message titled watch.yml (name Watch stock pairs, schedule every 10 minutes, workflow_dispatch with dry_run and test_ping, node 20, run node --test then node src/watch.mjs, then commit state/seen.json).

Env vars the job needs: DISCORD_WEBHOOK_URL, DISCORD_WEBHOOK_URL_2, RPC_URL, DRY_RUN, TEST_PING.
