import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Robinhood realtime listener requires explicit production WebSocket", async () => {
  const env = { ...process.env };
  delete env.REALTIME_RPC_WS_URL;
  delete env.RPC_WS_URL;
  delete env.RPC_URL;
  delete env.ALLOW_PUBLIC_ROBINHOOD_RPC;

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /REALTIME_RPC_WS_URL is required/);
      return true;
    }
  );
});

test("Robinhood realtime listener can require QuickNode endpoint", async () => {
  const env = {
    ...process.env,
    REALTIME_RPC_WS_URL: "wss://example.com/not-quicknode",
    REQUIRE_QUICKNODE_ROBINHOOD: "1",
  };
  delete env.RPC_WS_URL;
  delete env.RPC_URL;
  delete env.ALLOW_PUBLIC_ROBINHOOD_RPC;

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /must be a QuickNode Robinhood WebSocket URL/);
      return true;
    }
  );
});

test("Robinhood realtime listener exits without restart when shared kill switch is active", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-realtime-"));
  const killSwitchPath = path.join(dir, "KILL_SWITCH");
  await fs.writeFile(killSwitchPath, "manual stop\n");
  const env = {
    ...process.env,
    REALTIME_RPC_WS_URL: "wss://test.robinhood-mainnet.quiknode.pro/token/",
    REQUIRE_QUICKNODE_ROBINHOOD: "1",
    BUDGET_STATE_PATH: path.join(dir, "budget.json"),
    KILL_SWITCH_PATH: killSwitchPath,
    WEEKLY_BUDGET_USD: "1000",
    HELIUS_MONTHLY_PLAN_USD: "0",
    QUICKNODE_MONTHLY_PLAN_USD: "0",
    DIGITALOCEAN_MONTHLY_USD: "6",
    DIGITALOCEAN_MONTHLY_HARD_CAP_USD: "6",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  };

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /robinhood realtime listener stopped: kill switch active/);
      return true;
    }
  );
});

test("Robinhood realtime listener fails closed without required QuickNode telemetry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-realtime-"));
  const env = {
    ...process.env,
    REALTIME_RPC_WS_URL: "wss://test.robinhood-mainnet.quiknode.pro/token/",
    REQUIRE_QUICKNODE_ROBINHOOD: "1",
    BUDGET_STATE_PATH: path.join(dir, "budget.json"),
    KILL_SWITCH_PATH: path.join(dir, "KILL_SWITCH"),
    QUICKNODE_ADMIN_API_KEY: "",
    REQUIRE_QUICKNODE_BUDGET_API: "1",
    DIGITALOCEAN_BILLING_TOKEN: "",
    REQUIRE_DIGITALOCEAN_BUDGET_API: "",
    HELIUS_API_KEY: "",
    HELIUS_PROJECT_ID: "",
    REQUIRE_HELIUS_BUDGET_API: "",
  };

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 2);
      assert.match(err.stderr, /budget telemetry unavailable: QUICKNODE_ADMIN_API_KEY/);
      return true;
    }
  );
});
