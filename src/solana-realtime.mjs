import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createBudgetGuard,
  isBudgetStopError,
} from "./budget.mjs";
import {
  PUMP_PROGRAM,
  STONKFUN_PAIRS_URL,
  buildSolanaEmbed,
  csvSet,
  emptyState,
  extractStonkfunStockPairs,
  findPumpStockLaunch,
  applyPumpStockLaunches,
  isInterestingSolanaAsset,
  redactUrl,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, "state", "seen.json");
const budgetStatePath = path.join(root, "state", "budget.json");
const killSwitchPath = path.join(root, "state", "KILL_SWITCH");
const UA = "stock-pair-alerts/1.5";
const DEFAULT_SOLANA_RPC_HTTP = "https://api.mainnet-beta.solana.com";
const DEFAULT_SOLANA_RPC_WS = "wss://api.mainnet-beta.solana.com";
const STOCK_REFRESH_MS = Number(process.env.SOLANA_STOCK_REFRESH_MS || 300_000);
const BUDGET_CHECK_MS = Number(process.env.BUDGET_CHECK_MS || 60_000);

const enabledProtocols = csvSet(process.env.SOLANA_WATCH_PROTOCOLS || "pump");
const includeSymbols = csvSet(process.env.INTERESTING_SYMBOLS, { normalize: (v) => v.toUpperCase() });
const excludeSymbols = csvSet(process.env.IGNORE_SYMBOLS, { normalize: (v) => v.toUpperCase() });
const includeAddresses = csvSet(process.env.INTERESTING_ADDRESSES, { normalize: (v) => v });
const excludeAddresses = csvSet(process.env.IGNORE_ADDRESSES, { normalize: (v) => v });
const interestingOptions = { includeSymbols, excludeSymbols, includeAddresses, excludeAddresses };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function solanaHttpUrlFromEnv() {
  const raw = String(process.env.SOLANA_RPC_HTTP_URL || "").trim();
  if (raw) return raw;
  if (process.env.ALLOW_PUBLIC_SOLANA_RPC === "1") return DEFAULT_SOLANA_RPC_HTTP;
  throw new Error("SOLANA_RPC_HTTP_URL is required for the Solana realtime listener. Set ALLOW_PUBLIC_SOLANA_RPC=1 only for local smoke tests.");
}

function solanaWsUrlFromEnv() {
  const raw = String(process.env.SOLANA_RPC_WS_URL || "").trim();
  if (raw) return raw;
  const http = solanaHttpUrlFromEnv();
  if (/^https:\/\//i.test(http)) return http.replace(/^https:\/\//i, "wss://");
  if (/^http:\/\//i.test(http)) return http.replace(/^http:\/\//i, "ws://");
  if (process.env.ALLOW_PUBLIC_SOLANA_RPC === "1") return DEFAULT_SOLANA_RPC_WS;
  throw new Error("SOLANA_RPC_WS_URL is required for the Solana realtime listener.");
}

function webhooksFromEnv() {
  return [process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2].filter(
    (u) => u && u.startsWith("https://")
  );
}

async function readState() {
  try {
    return { ...emptyState(), ...JSON.parse(await fs.readFile(statePath, "utf8")) };
  } catch {
    return emptyState();
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "user-agent": UA, accept: "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error((opts.method || "GET") + " " + url + " -> " + res.status + " non-json: " + text.slice(0, 120));
  }
  if (!res.ok) {
    throw new Error((opts.method || "GET") + " " + url + " -> " + res.status + " " + text.slice(0, 180));
  }
  return body;
}

async function notify(webhooks, embed) {
  const payload = JSON.stringify({ username: "stock pair alerts", embeds: [embed] });
  for (const url of webhooks) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: payload,
      });
      if ([200, 204].includes(res.status)) break;
      const body = await res.text();
      if (res.status === 429 && attempt < 5) {
        let wait = 1;
        try { wait = Number(JSON.parse(body).retry_after) || 1; } catch {}
        wait = Math.min(Math.max(wait, 0.3), 8);
        console.warn("Discord 429, retry in", wait, "s");
        await sleep(wait * 1000 + 150);
        continue;
      }
      throw new Error("Discord " + res.status + " " + body.slice(0, 120));
    }
  }
}

function makeStockCache() {
  let value = {};
  let refreshedAt = 0;
  return {
    async get({ force = false } = {}) {
      const stale = Date.now() - refreshedAt > STOCK_REFRESH_MS;
      if (force || stale || !Object.keys(value).length) {
        value = extractStonkfunStockPairs(await httpJson(STONKFUN_PAIRS_URL));
        refreshedAt = Date.now();
        console.log(JSON.stringify({
          solanaStockCount: Object.keys(value).length,
          refreshedAt: new Date(refreshedAt).toISOString(),
        }));
      }
      return value;
    },
  };
}

async function solanaRpc(httpUrl, method, params) {
  const body = await httpJson(httpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body.error) throw new Error(method + " " + JSON.stringify(body.error));
  return body.result;
}

async function postOrLogAlert(hooks, alert) {
  console.log(JSON.stringify({ alert }));
  if (!hooks.length) {
    console.warn("alert ready but DISCORD_WEBHOOK_URL is not set");
    return;
  }
  try {
    await notify(hooks, buildSolanaEmbed(alert));
  } catch (err) {
    console.warn("notify failed:", err.message);
  }
}

function alertAllowed(meta, address) {
  return isInterestingSolanaAsset({ address, symbol: meta.symbol }, interestingOptions);
}

function isPumpCreateLog(logs) {
  return (logs || []).some((line) => /Instruction:\s*Create\b/i.test(line));
}

async function handlePumpSignature({ state, signature, slot, httpUrl, stockCache, hooks }) {
  if (!signature || (state.pumpStockLaunches || []).includes(signature)) return state;
  const tx = await solanaRpc(httpUrl, "getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) return state;
  tx.slot = tx.slot || slot;

  let stockMap = await stockCache.get();
  let event = findPumpStockLaunch(tx, stockMap);
  if (!event) {
    stockMap = await stockCache.get({ force: true });
    event = findPumpStockLaunch(tx, stockMap);
  }
  if (!event) return state;

  const pump = applyPumpStockLaunches(state, [event], { stockMap, allowAlerts: true });
  const next = { ...state, initialized: true, pumpStockLaunches: pump.pumpStockLaunches };
  if (!pump.alerts.length) return next;

  const meta = stockMap[event.quoteMint] || {};
  if (!alertAllowed(meta, event.quoteMint)) return next;

  await postOrLogAlert(hooks, {
    platform: "Pump.fun",
    symbol: meta.symbol,
    name: meta.name,
    address: event.quoteMint,
    tx: event.signature,
    extra: "Pump create transaction referenced a Solana stock quote mint.",
  });
  return next;
}

function makeBudgetChecker(budgetGuard) {
  let lastChecked = 0;
  return async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastChecked < BUDGET_CHECK_MS) return;
    await budgetGuard.check({ force });
    lastChecked = now;
  };
}

async function runConnection({ wsUrl, httpUrl, stockCache, hooks, budgetGuard }) {
  if (!enabledProtocols.has("pump")) {
    throw new Error("No Solana protocols enabled. Set SOLANA_WATCH_PROTOCOLS=pump.");
  }

  let state = await readState();
  let nextId = 1;
  const checkBudget = makeBudgetChecker(budgetGuard);
  await stockCache.get();
  await checkBudget({ force: true });
  console.log(JSON.stringify({
    mode: "solana-realtime",
    wsUrl: redactUrl(wsUrl),
    httpUrl: redactUrl(httpUrl),
    protocols: ["pump"],
    hasWebhook: hooks.length > 0,
    interestingSymbols: [...includeSymbols],
    ignoreSymbols: [...excludeSymbols],
  }));

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }],
      }));
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.id && msg.result) {
          console.log(JSON.stringify({ subscribed: "pump", subscription: msg.result }));
          return;
        }
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        const value = msg.params?.result?.value;
        if (!value || value.err || !isPumpCreateLog(value.logs)) return;
        await checkBudget();
        state = await handlePumpSignature({
          state,
          signature: value.signature,
          slot: msg.params?.result?.context?.slot,
          httpUrl,
          stockCache,
          hooks,
        });
        await writeState(state);
      } catch (err) {
        if (isBudgetStopError(err)) {
          console.error(err.message);
          finish(err);
          return;
        }
        console.warn("message handling failed:", err.stack || err.message);
      }
    });

    ws.on("ping", () => ws.pong());
    ws.on("error", (err) => console.warn("websocket error:", err.message));
    ws.on("close", (code, reason) => {
      console.warn("websocket closed:", code, reason.toString());
      finish();
    });
  });
}

async function main() {
  const httpUrl = solanaHttpUrlFromEnv();
  const wsUrl = solanaWsUrlFromEnv();
  const hooks = webhooksFromEnv();
  const stockCache = makeStockCache();
  const budgetGuard = await createBudgetGuard({ statePath: budgetStatePath, killSwitchPath });
  let attempt = 0;
  for (;;) {
    try {
      await runConnection({ wsUrl, httpUrl, stockCache, hooks, budgetGuard });
      attempt += 1;
    } catch (err) {
      if (isBudgetStopError(err)) {
        console.error("solana realtime listener stopped:", err.message);
        process.exit(2);
      }
      attempt += 1;
      console.warn("solana realtime listener failed:", err.stack || err.message);
    }
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    console.warn("reconnecting in", wait, "ms");
    await sleep(wait);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
