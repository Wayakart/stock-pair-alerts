import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBudgetGuard,
  estimateHeliusUsd,
  isBudgetStopError,
} from "../src/budget.mjs";

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test("estimateHeliusUsd includes plan plus credit overage", () => {
  const usd = estimateHeliusUsd(
    { creditsUsed: 150_000_000, subscriptionDetails: { creditsLimit: 100_000_000 } },
    { planUsd: 499, extraCreditUsdPerMillion: 5 }
  );
  assert.equal(usd, 749);
});

test("estimateHeliusUsd treats a reported free plan as zero spend", () => {
  const usd = estimateHeliusUsd(
    { creditsUsed: 32_057, subscriptionDetails: { creditsLimit: 1_000_000, plan: "free" } },
    { planUsd: 499, extraCreditUsdPerMillion: 5 }
  );
  assert.equal(usd, 0);
});

test("budget guard includes configured infrastructure commitments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-budget-"));
  const statePath = path.join(dir, "budget.json");
  const killSwitchPath = path.join(dir, "KILL_SWITCH");

  await withEnv({
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "0",
    QUICKNODE_MONTHLY_PLAN_USD: "750",
    DIGITALOCEAN_MONTHLY_USD: "250",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  }, async () => {
    const guard = await createBudgetGuard({ statePath, killSwitchPath });
    await assert.rejects(() => guard.check(), /weekly budget exceeded/);
  });
});

test("budget guard writes kill switch at the weekly cap", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-budget-"));
  const statePath = path.join(dir, "seen.json");
  const killSwitchPath = path.join(dir, "KILL_SWITCH");

  await withEnv({
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "1000",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  }, async () => {
    const guard = await createBudgetGuard({ statePath, killSwitchPath });
    await assert.rejects(() => guard.check(), /weekly budget exceeded/);
  });

  const killSwitch = await fs.readFile(killSwitchPath, "utf8");
  assert.match(killSwitch, /budget exceeded/);
});

test("budget guard writes kill switch above the DigitalOcean configuration cap", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-budget-"));
  const statePath = path.join(dir, "budget.json");
  const killSwitchPath = path.join(dir, "KILL_SWITCH");

  await withEnv({
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "0",
    QUICKNODE_MONTHLY_PLAN_USD: "0",
    DIGITALOCEAN_MONTHLY_USD: "7",
    DIGITALOCEAN_MONTHLY_HARD_CAP_USD: "6",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  }, async () => {
    const guard = await createBudgetGuard({ statePath, killSwitchPath });
    await assert.rejects(() => guard.check(), /provider hard cap exceeded: DigitalOcean/);
  });

  const killSwitch = await fs.readFile(killSwitchPath, "utf8");
  assert.match(killSwitch, /DigitalOcean provider hard cap exceeded/);
});

test("budget guard refuses to start when manual kill switch exists", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-budget-"));
  const statePath = path.join(dir, "seen.json");
  const killSwitchPath = path.join(dir, "KILL_SWITCH");
  await fs.writeFile(killSwitchPath, "manual stop\n");

  await withEnv({
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "499",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  }, async () => {
    const guard = await createBudgetGuard({ statePath, killSwitchPath });
    await assert.rejects(() => guard.check(), /kill switch active/);
  });
});

test("budget guard reports warning thresholds once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-budget-"));
  const statePath = path.join(dir, "budget.json");
  const killSwitchPath = path.join(dir, "KILL_SWITCH");

  await withEnv({
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "850",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  }, async () => {
    const guard = await createBudgetGuard({ statePath, killSwitchPath });
    const first = await guard.check();
    const second = await guard.check();
    assert.equal(first.crossedThreshold, 0.8);
    assert.equal(second.crossedThreshold, undefined);
  });
});

test("isBudgetStopError recognizes fatal budget stops", () => {
  assert.equal(isBudgetStopError(new Error("weekly budget exceeded: $1000")), true);
  assert.equal(isBudgetStopError(new Error("kill switch active: state/KILL_SWITCH")), true);
  assert.equal(isBudgetStopError(new Error("provider hard cap exceeded: DigitalOcean $7 > $6")), true);
  assert.equal(isBudgetStopError(new Error("temporary websocket close")), false);
});
