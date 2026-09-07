import { logJson } from "./metrics.mjs";

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(name + " must be a number");
  return n;
}

export function createDryRunDecisionEngine({
  enabled = process.env.DRY_RUN_DECISIONS !== "0",
  maxUsd = numEnv("DRY_RUN_MAX_USD", 100),
  maxSlippageBps = numEnv("DRY_RUN_MAX_SLIPPAGE_BPS", 500),
} = {}) {
  return {
    async evaluate(alert, context = {}) {
      if (!enabled) return null;
      const decision = {
        action: "would_buy",
        platform: alert.platform,
        symbol: alert.symbol || null,
        address: alert.address,
        tx: alert.tx,
        maxUsd,
        maxSlippageBps,
        reason: "new interesting stock-pair signal",
        receivedToDecisionMs: context.receivedToDecisionMs,
      };
      logJson("dry_run_decision", decision);
      return decision;
    },
  };
}
