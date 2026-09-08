import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonFile } from "./state.mjs";

const DEFAULT_WEEKLY_BUDGET_USD = 1000;
const DEFAULT_PLAN_USD = 499;
const DEFAULT_INCLUDED_CREDITS = 100_000_000;
const DEFAULT_EXTRA_CREDIT_USD_PER_MILLION = 5;
const DEFAULT_QUICKNODE_INCLUDED_CREDITS = 450_000_000;
const DEFAULT_QUICKNODE_EXTRA_CREDIT_USD_PER_MILLION = 0.56;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUDGET_WARNING_THRESHOLDS = [0.8, 0.9, 0.95];

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

async function writeKillSwitch(file, reason) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, reason + "\n");
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
  return /kill switch active|weekly budget exceeded|provider hard cap exceeded|budget telemetry unavailable/i.test(
    String(err?.message || err)
  );
}

export function estimateHeliusUsd(usage, {
  planUsd = DEFAULT_PLAN_USD,
  includedCredits = DEFAULT_INCLUDED_CREDITS,
  extraCreditUsdPerMillion = DEFAULT_EXTRA_CREDIT_USD_PER_MILLION,
} = {}) {
  if (String(usage?.subscriptionDetails?.plan || "").toLowerCase() === "free") return 0;
  const creditsUsed = Number(usage?.creditsUsed || 0);
  const included = Number(usage?.subscriptionDetails?.creditsLimit || includedCredits);
  const overageCredits = Math.max(0, creditsUsed - included);
  return planUsd + (overageCredits / 1_000_000) * extraCreditUsdPerMillion;
}

export function estimateQuickNodeUsd(usage, {
  planUsd = 0,
  includedCredits = DEFAULT_QUICKNODE_INCLUDED_CREDITS,
  extraCreditUsdPerMillion = DEFAULT_QUICKNODE_EXTRA_CREDIT_USD_PER_MILLION,
} = {}) {
  const data = usage?.data || usage || {};
  const creditsUsed = Number(data.credits_used || 0);
  const limit = Number(data.limit || includedCredits);
  const overageCredits = Math.max(0, Number(data.overages ?? (creditsUsed - limit)) || 0);
  return planUsd + (overageCredits / 1_000_000) * extraCreditUsdPerMillion;
}

export function summarizeQuickNodeInvoices(payload, { sinceMs = 0 } = {}) {
  const invoices = payload?.data?.invoices || payload?.invoices || [];
  let paidSinceUsd = 0;
  let latestCreatedMs = 0;
  let longestPeriodDays = 0;
  for (const invoice of invoices) {
    const createdMs = Number(invoice.created || 0) * 1000;
    if (createdMs >= sinceMs && String(invoice.status || "").toLowerCase() === "paid") {
      paidSinceUsd += Number(invoice.amount_paid || 0) / 100;
    }
    if (createdMs >= latestCreatedMs) {
      latestCreatedMs = createdMs;
      longestPeriodDays = 0;
      for (const line of invoice.lines || []) {
        const periodDays = (Number(line.period_end || 0) - Number(line.period_start || 0)) / 86_400;
        if (Number.isFinite(periodDays)) longestPeriodDays = Math.max(longestPeriodDays, periodDays);
      }
    }
  }
  const cadence = longestPeriodDays >= 300
    ? "yearly"
    : longestPeriodDays >= 20 && longestPeriodDays <= 40
      ? "monthly"
      : "unknown";
  return { paidSinceUsd, cadence };
}

async function providerJson(name, url, options) {
  const res = await fetch(url, { ...options, signal: options?.signal || AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(name + " returned non-json");
  }
  if (!res.ok || body?.error) {
    throw new Error(name + " request failed with status " + res.status);
  }
  return body;
}

export async function fetchHeliusUsage({ apiKey, projectId }) {
  if (!apiKey || !projectId) return null;
  const res = await fetch("https://admin-api.helius.xyz/v0/admin/projects/" + projectId + "/usage", {
    headers: { "X-Api-Key": apiKey },
    signal: AbortSignal.timeout(10_000),
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

export async function fetchQuickNodeUsage({ apiKey }) {
  if (!apiKey) return null;
  return providerJson("QuickNode Admin API", "https://api.quicknode.com/v0/usage/rpc", {
    headers: { accept: "application/json", "x-api-key": apiKey },
  });
}

export async function fetchQuickNodeInvoices({ apiKey }) {
  if (!apiKey) return null;
  return providerJson("QuickNode Billing API", "https://api.quicknode.com/v0/billing/invoices", {
    headers: { accept: "application/json", "x-api-key": apiKey },
  });
}

export async function fetchDigitalOceanBalance({ token }) {
  if (!token) return null;
  return providerJson("DigitalOcean Billing API", "https://api.digitalocean.com/v2/customers/my/balance", {
    headers: { accept: "application/json", authorization: "Bearer " + token },
  });
}

export async function createBudgetGuard({ statePath, killSwitchPath, now = () => Date.now() }) {
  const budgetUsd = numEnv("WEEKLY_BUDGET_USD", DEFAULT_WEEKLY_BUDGET_USD);
  const planUsd = numEnv("HELIUS_MONTHLY_PLAN_USD", DEFAULT_PLAN_USD);
  const includedCredits = numEnv("HELIUS_INCLUDED_CREDITS", DEFAULT_INCLUDED_CREDITS);
  const extraCreditUsdPerMillion = numEnv(
    "HELIUS_EXTRA_CREDIT_USD_PER_MILLION",
    DEFAULT_EXTRA_CREDIT_USD_PER_MILLION
  );
  const quicknodeMonthlyUsd = numEnv("QUICKNODE_MONTHLY_PLAN_USD", 0);
  const quicknodeIncludedCredits = numEnv("QUICKNODE_INCLUDED_CREDITS", DEFAULT_QUICKNODE_INCLUDED_CREDITS);
  const quicknodeExtraCreditUsdPerMillion = numEnv(
    "QUICKNODE_EXTRA_CREDIT_USD_PER_MILLION",
    DEFAULT_QUICKNODE_EXTRA_CREDIT_USD_PER_MILLION
  );
  const digitalOceanMonthlyUsd = numEnv("DIGITALOCEAN_MONTHLY_USD", 0);
  const digitalOceanMonthlyHardCapUsd = numEnv(
    "DIGITALOCEAN_MONTHLY_HARD_CAP_USD",
    digitalOceanMonthlyUsd
  );
  const requireHeliusBudgetApi = boolEnv("REQUIRE_HELIUS_BUDGET_API");
  const requireQuickNodeBudgetApi = boolEnv("REQUIRE_QUICKNODE_BUDGET_API");
  const requireDigitalOceanBudgetApi = boolEnv("REQUIRE_DIGITALOCEAN_BUDGET_API");
  const apiKey = process.env.HELIUS_API_KEY;
  const projectId = process.env.HELIUS_PROJECT_ID;
  const quicknodeApiKey = process.env.QUICKNODE_ADMIN_API_KEY;
  const digitalOceanToken = process.env.DIGITALOCEAN_BILLING_TOKEN;
  if (requireHeliusBudgetApi && (!apiKey || !projectId)) {
    throw new Error("budget telemetry unavailable: HELIUS_API_KEY and HELIUS_PROJECT_ID are required");
  }
  if (requireQuickNodeBudgetApi && !quicknodeApiKey) {
    throw new Error("budget telemetry unavailable: QUICKNODE_ADMIN_API_KEY is required");
  }
  if (requireDigitalOceanBudgetApi && !digitalOceanToken) {
    throw new Error("budget telemetry unavailable: DIGITALOCEAN_BILLING_TOKEN is required");
  }

  return {
    async check({ force = false } = {}) {
      if (await killSwitchActive(killSwitchPath)) {
        throw new Error("kill switch active: " + killSwitchPath);
      }
      if (digitalOceanMonthlyUsd > digitalOceanMonthlyHardCapUsd) {
        const checkedAt = new Date(now()).toISOString();
        await writeKillSwitch(killSwitchPath, "DigitalOcean provider hard cap exceeded at " + checkedAt);
        throw new Error(
          "provider hard cap exceeded: DigitalOcean $" + digitalOceanMonthlyUsd.toFixed(2)
          + " > $" + digitalOceanMonthlyHardCapUsd.toFixed(2)
        );
      }

      const state = await readJsonFile(statePath, {});
      const budget = state.budget || {};
      const startedAt = budget.weekStartedAt || new Date(now()).toISOString();
      const startedMs = Date.parse(startedAt);
      const nextBudget = { ...budget, weekStartedAt: startedAt };
      if (Number.isFinite(startedMs) && now() - startedMs >= WEEK_MS) {
        nextBudget.weekStartedAt = new Date(now()).toISOString();
        nextBudget.localUsdSpent = 0;
        nextBudget.warnedThresholds = [];
      }

      const localUsdSpent = Number(nextBudget.localUsdSpent || 0);
      let heliusUsage = null;
      let heliusUsd = planUsd;
      if (apiKey && projectId) {
        try {
          heliusUsage = await fetchHeliusUsage({ apiKey, projectId });
        } catch (err) {
          throw new Error("budget telemetry unavailable: " + err.message);
        }
        heliusUsd = estimateHeliusUsd(heliusUsage, {
          planUsd,
          includedCredits,
          extraCreditUsdPerMillion,
        });
      }

      let quicknodeUsage = null;
      let quicknodeInvoices = null;
      let quicknodeUsd = quicknodeMonthlyUsd;
      if (quicknodeApiKey) {
        try {
          [quicknodeUsage, quicknodeInvoices] = await Promise.all([
            fetchQuickNodeUsage({ apiKey: quicknodeApiKey }),
            fetchQuickNodeInvoices({ apiKey: quicknodeApiKey }),
          ]);
        } catch (err) {
          throw new Error("budget telemetry unavailable: " + err.message);
        }
        quicknodeUsd = estimateQuickNodeUsd(quicknodeUsage, {
          planUsd: quicknodeMonthlyUsd,
          includedCredits: quicknodeIncludedCredits,
          extraCreditUsdPerMillion: quicknodeExtraCreditUsdPerMillion,
        });
        const invoiceSummary = summarizeQuickNodeInvoices(quicknodeInvoices, { sinceMs: now() - WEEK_MS });
        quicknodeUsd = Math.max(quicknodeUsd, invoiceSummary.paidSinceUsd);
      }

      let digitalOceanBalance = null;
      if (digitalOceanToken) {
        try {
          digitalOceanBalance = await fetchDigitalOceanBalance({ token: digitalOceanToken });
        } catch (err) {
          throw new Error("budget telemetry unavailable: " + err.message);
        }
      }
      const digitalOceanMonthToDateUsd = Number(digitalOceanBalance?.month_to_date_usage || 0);
      const digitalOceanUsd = Math.max(digitalOceanMonthlyUsd, digitalOceanMonthToDateUsd);
      const fixedProviderUsd = quicknodeUsd + digitalOceanUsd;
      const estimatedUsd = heliusUsd + fixedProviderUsd + localUsdSpent;
      const warnedThresholds = new Set((nextBudget.warnedThresholds || []).map(String));
      const crossedThreshold = BUDGET_WARNING_THRESHOLDS.find((threshold) => {
        return estimatedUsd >= budgetUsd * threshold && !warnedThresholds.has(String(threshold));
      });
      if (crossedThreshold) warnedThresholds.add(String(crossedThreshold));
      nextBudget.weeklyBudgetUsd = budgetUsd;
      nextBudget.heliusEstimatedUsd = heliusUsd;
      nextBudget.quicknodeEstimatedUsd = quicknodeUsd;
      nextBudget.quicknodeCreditsUsed = Number((quicknodeUsage?.data || quicknodeUsage)?.credits_used || 0);
      nextBudget.quicknodeCreditsRemaining = Number((quicknodeUsage?.data || quicknodeUsage)?.credits_remaining || 0);
      nextBudget.quicknodeOverageCredits = Number((quicknodeUsage?.data || quicknodeUsage)?.overages || 0);
      nextBudget.quicknodeInvoiceSpendUsd = summarizeQuickNodeInvoices(quicknodeInvoices, {
        sinceMs: now() - WEEK_MS,
      }).paidSinceUsd;
      nextBudget.quicknodeBillingCadence = summarizeQuickNodeInvoices(quicknodeInvoices).cadence;
      nextBudget.digitalOceanEstimatedUsd = digitalOceanUsd;
      nextBudget.digitalOceanMonthToDateUsd = digitalOceanMonthToDateUsd;
      nextBudget.digitalOceanUsageGeneratedAt = digitalOceanBalance?.generated_at;
      nextBudget.digitalOceanMonthlyHardCapUsd = digitalOceanMonthlyHardCapUsd;
      nextBudget.fixedProviderUsd = fixedProviderUsd;
      nextBudget.localUsdSpent = localUsdSpent;
      nextBudget.estimatedUsd = estimatedUsd;
      nextBudget.lastCheckedAt = new Date(now()).toISOString();
      nextBudget.heliusCreditsUsed = heliusUsage?.creditsUsed;
      nextBudget.heliusCreditsRemaining = heliusUsage?.creditsRemaining;
      nextBudget.warnedThresholds = [...warnedThresholds];
      state.budget = nextBudget;
      await writeJsonFile(statePath, state);

      if (digitalOceanBalance && digitalOceanMonthToDateUsd >= digitalOceanMonthlyHardCapUsd) {
        await writeKillSwitch(killSwitchPath, "DigitalOcean monthly usage cap reached at " + nextBudget.lastCheckedAt);
        throw new Error(
          "provider hard cap exceeded: DigitalOcean month-to-date $" + digitalOceanMonthToDateUsd.toFixed(2)
          + " >= $" + digitalOceanMonthlyHardCapUsd.toFixed(2)
        );
      }

      if (estimatedUsd >= budgetUsd) {
        await writeKillSwitch(killSwitchPath, "budget exceeded at " + nextBudget.lastCheckedAt);
        throw new Error("weekly budget exceeded: $" + estimatedUsd.toFixed(2) + " >= $" + budgetUsd.toFixed(2));
      }

      if (force || estimatedUsd >= budgetUsd * 0.8) {
        console.log(JSON.stringify({
          budget: {
            estimatedUsd,
            weeklyBudgetUsd: budgetUsd,
            heliusEstimatedUsd: heliusUsd,
            fixedProviderUsd,
            localUsdSpent,
            heliusCreditsUsed: heliusUsage?.creditsUsed,
          },
        }));
      }
      return { ...nextBudget, crossedThreshold };
    },
  };
}
