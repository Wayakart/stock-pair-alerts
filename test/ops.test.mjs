import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAlertCap } from "../src/alert-cap.mjs";
import { createDryRunDecisionEngine } from "../src/decision.mjs";
import { createHeartbeat } from "../src/metrics.mjs";
import { buildStatusEmbed } from "../src/lib.mjs";
import { appendJsonLine, readJsonFile, writeJsonFile } from "../src/state.mjs";

test("state helper writes and reads json atomically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-state-"));
  const file = path.join(dir, "nested", "state.json");
  await writeJsonFile(file, { ok: true });
  assert.deepEqual(await readJsonFile(file, {}), { ok: true });
});

test("history helper appends replayable JSON lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-history-"));
  const file = path.join(dir, "nested", "events.ndjson");
  await appendJsonLine(file, { type: "candidate", id: 1 });
  await appendJsonLine(file, { type: "trade", id: 2 });
  const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows, [{ type: "candidate", id: 1 }, { type: "trade", id: 2 }]);
});

test("alert cap persists a rolling global Discord limit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-cap-"));
  const statePath = path.join(dir, "alert-cap.json");
  const historyPath = path.join(dir, "alert-events.ndjson");
  let nowMs = Date.parse("2026-09-08T01:00:00Z");
  const cap = createAlertCap({
    statePath,
    historyPath,
    maxAlerts: 2,
    windowMs: 8 * 60 * 60 * 1_000,
    now: () => nowMs,
  });

  assert.equal((await cap.reserve({ projectSymbol: "ONE" })).allowed, true);
  assert.equal((await cap.reserve({ projectSymbol: "TWO" })).allowed, true);
  const blocked = await cap.reserve({ projectSymbol: "THREE" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);

  nowMs += 8 * 60 * 60 * 1_000 + 1;
  const reopened = await cap.reserve({ projectSymbol: "FOUR" });
  assert.equal(reopened.allowed, true);
  assert.equal(reopened.remaining, 1);

  const rows = (await fs.readFile(historyPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.type), [
    "alert_reserved",
    "alert_reserved",
    "alert_suppressed",
    "alert_reserved",
  ]);
});

test("alert cap serializes concurrent reservations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-pair-alerts-cap-race-"));
  const cap = createAlertCap({
    statePath: path.join(dir, "alert-cap.json"),
    maxAlerts: 10,
    windowMs: 8 * 60 * 60 * 1_000,
  });
  const results = await Promise.all(Array.from({ length: 25 }, (_, index) => cap.reserve({ index })));
  assert.equal(results.filter((result) => result.allowed).length, 10);
  assert.equal(results.filter((result) => !result.allowed).length, 15);
});

test("dry-run decision engine logs would-buy decisions", async () => {
  const engine = createDryRunDecisionEngine({ maxUsd: 42, maxSlippageBps: 250 });
  const decision = await engine.evaluate({
    platform: "Pons",
    symbol: "NVDA",
    address: "0xabc",
    tx: "0x123",
  }, { receivedToDecisionMs: 3.2, reason: "early buyer momentum" });
  assert.equal(decision.action, "would_buy");
  assert.equal(decision.maxUsd, 42);
  assert.equal(decision.maxSlippageBps, 250);
  assert.equal(decision.receivedToDecisionMs, 3.2);
  assert.equal(decision.reason, "early buyer momentum");
});

test("heartbeat emits stale callback once per stale window", async () => {
  let staleCalls = 0;
  const heartbeat = createHeartbeat({
    service: "test",
    intervalMs: 1,
    staleMs: 20,
    onStale: async () => { staleCalls += 1; },
  });
  heartbeat.message();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await heartbeat.tick({ force: true });
  await heartbeat.tick({ force: true });
  assert.equal(staleCalls, 1);
});

test("buildStatusEmbed creates a non-chain status notification", () => {
  const embed = buildStatusEmbed({
    title: "Budget warning",
    level: "warn",
    service: "solana",
    message: "Budget crossed 80%.",
  });
  assert.equal(embed.title, "Budget warning");
  assert.equal(embed.color, 0xf1c40f);
  assert.equal(embed.fields[0].value, "solana");
});
