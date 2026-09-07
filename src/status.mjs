import fs from "node:fs/promises";
import { fetchHeliusUsage } from "./budget.mjs";
import { readJsonFile } from "./state.mjs";

async function loadEnvFile(file) {
  if (!file) return;
  const text = await fs.readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : "";
}

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function monthlyToWeek(usd) {
  return (usd * 12) / 52;
}

async function main() {
  await loadEnvFile(argValue("--env"));
  const legacy = await readJsonFile("state/seen.json", {});
  const robinhood = await readJsonFile("state/robinhood.json", legacy);
  const solana = await readJsonFile("state/solana.json", legacy);
  const budgetState = await readJsonFile("state/budget.json", {});
  const heliusUsage = await fetchHeliusUsage({
    apiKey: process.env.HELIUS_API_KEY,
    projectId: process.env.HELIUS_PROJECT_ID,
  });

  const quicknodeMonthlyUsd = numEnv("QUICKNODE_MONTHLY_PLAN_USD", 249);
  const digitalOceanMonthlyUsd = numEnv("DIGITALOCEAN_MONTHLY_USD", 6);
  const heliusMonthlyUsd = numEnv("HELIUS_MONTHLY_PLAN_USD", 499);
  const weeklyFixedUsd =
    monthlyToWeek(quicknodeMonthlyUsd) +
    monthlyToWeek(digitalOceanMonthlyUsd) +
    monthlyToWeek(heliusMonthlyUsd);

  const weekStartedAt = budgetState.budget?.weekStartedAt;
  const elapsedDays = weekStartedAt
    ? Math.max(1 / 24, (Date.now() - Date.parse(weekStartedAt)) / 86_400_000)
    : null;
  const heliusCreditsUsed = Number(heliusUsage?.creditsUsed || 0);
  const projectedHeliusCreditsWeek = elapsedDays ? Math.round((heliusCreditsUsed / elapsedDays) * 7) : null;

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    listings: {
      ponsApproved: robinhood.ponsApproved?.length || 0,
      longNumeraires: robinhood.longNumeraires?.length || 0,
      flapPairs: robinhood.flapPairs?.length || 0,
      pairPools: robinhood.pairPools?.length || 0,
      pumpStockLaunches: solana.pumpStockLaunches?.length || 0,
    },
    helius: {
      plan: heliusUsage?.subscriptionDetails?.plan,
      creditsUsed: heliusCreditsUsed,
      creditsRemaining: heliusUsage?.creditsRemaining,
      projectedCreditsWeek: projectedHeliusCreditsWeek,
    },
    budget: budgetState.budget || null,
    projectedSpend: {
      quicknodeMonthlyUsd,
      heliusMonthlyUsd,
      digitalOceanMonthlyUsd,
      weeklyFixedUsd: Number(weeklyFixedUsd.toFixed(2)),
      note: "Fixed weekly projection is monthly plan costs annualized to one week; provider bills may charge monthly upfront.",
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
