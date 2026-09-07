import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_WEEKLY_BUDGET_USD = 1000;
const DEFAULT_PLAN_USD = 499;
const DEFAULT_INCLUDED_CREDITS = 100_000_000;
const DEFAULT_EXTRA_CREDIT_USD_PER_MILLION = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(name + " must be a number");
  return n;
}

function boolEnv(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function killSwitchActive(file) {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

export function isBudgetStopError(err) {
  return /kill switch active|weekly budget exceeded/i.test(String(err?.message || err));
}

export function estimateHeliusUsd(usage, {
  planUsd = DEFAULT_PLAN_USD,
  includedCredits = DEFAULT_INCLUDED_CREDITS,
  extraCreditUsdPerMillion = DEFAULT_EXTRA_CREDIT_USD_PER_MILLION,
} = {}) {
  const creditsUsed = Number(usage?.creditsUsed || 0);
  const included = Number(usage?.subscriptionDetails?.creditsLimit || includedCredits);
  const overageCredits = Math.max(0, creditsUsed - included);
  return planUsd + (overageCredits / 1_000_000) * extraCreditUsdPerMillion;
}

export async function fetchHeliusUsage({ apiKey, projectId }) {
  if (!apiKey || !projectId) return null;
  const res = await fetch("https://admin-api.helius.xyz/v0/admin/projects/" + projectId + "/usage", {
    headers: { "X-Api-Key": apiKey },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Helius Admin API returned non-json: " + text.slice(0, 120));
  }
  if (!res.ok || body?.error) {
    throw new Error("Helius Admin API " + res.status + " " + text.slice(0, 180));
  }
  return body;
}

export async function createBudgetGuard({ statePath, killSwitchPath, now = () => Date.now() }) {
  const budgetUsd = numEnv("WEEKLY_BUDGET_USD", DEFAULT_WEEKLY_BUDGET_USD);
  const planUsd = numEnv("HELIUS_MONTHLY_PLAN_USD", DEFAULT_PLAN_USD);
  const includedCredits = numEnv("HELIUS_INCLUDED_CREDITS", DEFAULT_INCLUDED_CREDITS);
  const extraCreditUsdPerMillion = numEnv(
    "HELIUS_EXTRA_CREDIT_USD_PER_MILLION",
    DEFAULT_EXTRA_CREDIT_USD_PER_MILLION
  );
  const requireHeliusBudgetApi = boolEnv("REQUIRE_HELIUS_BUDGET_API");
  const apiKey = process.env.HELIUS_API_KEY;
  const projectId = process.env.HELIUS_PROJECT_ID;
  if (requireHeliusBudgetApi && (!apiKey || !projectId)) {
    throw new Error("HELIUS_API_KEY and HELIUS_PROJECT_ID are required when REQUIRE_HELIUS_BUDGET_API=1");
  }

  return {
    async check({ force = false } = {}) {
      if (await killSwitchActive(killSwitchPath)) {
        throw new Error("kill switch active: " + killSwitchPath);
      }

      const state = await readJson(statePath, {});
      const budget = state.budget || {};
      const startedAt = budget.weekStartedAt || new Date(now()).toISOString();
      const startedMs = Date.parse(startedAt);
      const nextBudget = { ...budget, weekStartedAt: startedAt };
      if (Number.isFinite(startedMs) && now() - startedMs >= WEEK_MS) {
        nextBudget.weekStartedAt = new Date(now()).toISOString();
        nextBudget.localUsdSpent = 0;
      }

      const localUsdSpent = Number(nextBudget.localUsdSpent || 0);
      let heliusUsage = null;
      let heliusUsd = planUsd;
      if (apiKey && projectId) {
        heliusUsage = await fetchHeliusUsage({ apiKey, projectId });
        heliusUsd = estimateHeliusUsd(heliusUsage, {
          planUsd,
          includedCredits,
          extraCreditUsdPerMillion,
        });
      }

      const estimatedUsd = heliusUsd + localUsdSpent;
      nextBudget.weeklyBudgetUsd = budgetUsd;
      nextBudget.heliusEstimatedUsd = heliusUsd;
      nextBudget.localUsdSpent = localUsdSpent;
      nextBudget.estimatedUsd = estimatedUsd;
      nextBudget.lastCheckedAt = new Date(now()).toISOString();
      nextBudget.heliusCreditsUsed = heliusUsage?.creditsUsed;
      nextBudget.heliusCreditsRemaining = heliusUsage?.creditsRemaining;
      state.budget = nextBudget;
      await writeJson(statePath, state);

      if (estimatedUsd >= budgetUsd) {
        await fs.writeFile(killSwitchPath, "budget exceeded at " + nextBudget.lastCheckedAt + "\n");
        throw new Error("weekly budget exceeded: $" + estimatedUsd.toFixed(2) + " >= $" + budgetUsd.toFixed(2));
      }

      if (force || estimatedUsd >= budgetUsd * 0.8) {
        console.log(JSON.stringify({
          budget: {
            estimatedUsd,
            weeklyBudgetUsd: budgetUsd,
            heliusEstimatedUsd: heliusUsd,
            localUsdSpent,
            heliusCreditsUsed: heliusUsage?.creditsUsed,
          },
        }));
      }
      return nextBudget;
    },
  };
}
