import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { CommitmentLevel, subscribe } from "helius-laserstream";
import WebSocket from "ws";
import { createBudgetGuard, isBudgetStopError } from "./budget.mjs";
import { createDryRunDecisionEngine } from "./decision.mjs";
import {
  PUMP_PROGRAM,
  STONKFUN_PAIRS_URL,
  applyPumpStockLaunches,
  buildDiscordAlertPayload,
  buildStatusEmbed,
  csvSet,
  decodePumpCreateEvent,
  emptyState,
  extractStonkfunStockPairs,
  isPumpCreateLog,
  isInterestingSolanaAsset,
  redactUrl,
} from "./lib.mjs";
import { createHeartbeat, createLatencyTrace, logJson, msSince, warnJson } from "./metrics.mjs";
import { readJsonFile, writeJsonFile } from "./state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyStatePath = path.join(root, "state", "seen.json");
const statePath = path.join(root, "state", "solana.json");
const budgetStatePath = path.join(root, "state", "budget.json");
const killSwitchPath = path.join(root, "state", "KILL_SWITCH");
const UA = "stock-pair-alerts/1.6";
const DEFAULT_SOLANA_RPC_HTTP = "https://api.mainnet-beta.solana.com";
const DEFAULT_SOLANA_RPC_WS = "wss://api.mainnet-beta.solana.com";
const DEFAULT_LASERSTREAM_ENDPOINT = "https://laserstream-mainnet-ewr.helius-rpc.com";
const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const NATIVE_SOL_MINT = "11111111111111111111111111111111";
const NATIVE_QUOTE_MINTS = new Set([NATIVE_SOL_MINT, WRAPPED_SOL_MINT]);
const STOCK_REFRESH_MS = Number(process.env.SOLANA_STOCK_REFRESH_MS || 300_000);
const BUDGET_CHECK_MS = Number(process.env.BUDGET_CHECK_MS || 60_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60_000);
const STALE_CONNECTION_MS = Number(process.env.STALE_CONNECTION_MS || 180_000);
const STATE_FLUSH_MS = Number(process.env.SOLANA_STATE_FLUSH_MS || 1_000);
const REPLAY_OVERLAP_SLOTS = Number(process.env.SOLANA_REPLAY_OVERLAP_SLOTS || 128);
const SOLANA_STREAM_MODE = process.env.SOLANA_STREAM_MODE || "standard-wss";

const enabledProtocols = csvSet(process.env.SOLANA_WATCH_PROTOCOLS || "pump");
const includeSymbols = csvSet(process.env.INTERESTING_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const excludeSymbols = csvSet(process.env.IGNORE_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const includeAddresses = csvSet(process.env.INTERESTING_ADDRESSES, { normalize: (value) => value });
const excludeAddresses = csvSet(process.env.IGNORE_ADDRESSES, { normalize: (value) => value });
const interestingOptions = { includeSymbols, excludeSymbols, includeAddresses, excludeAddresses };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boolEnv(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function solanaHttpUrlFromEnv() {
  const raw = String(process.env.SOLANA_RPC_HTTP_URL || "").trim();
  if (raw) return raw;
  if (process.env.ALLOW_PUBLIC_SOLANA_RPC === "1") return DEFAULT_SOLANA_RPC_HTTP;
  throw new Error("SOLANA_RPC_HTTP_URL is required for the Solana realtime listener. Set ALLOW_PUBLIC_SOLANA_RPC=1 only for local smoke tests.");
}

function solanaWsUrlFromEnv(httpUrl) {
  const raw = String(process.env.SOLANA_RPC_WS_URL || "").trim();
  if (raw) return raw;
  if (/^https:\/\//i.test(httpUrl)) return httpUrl.replace(/^https:\/\//i, "wss://");
  if (/^http:\/\//i.test(httpUrl)) return httpUrl.replace(/^http:\/\//i, "ws://");
  if (process.env.ALLOW_PUBLIC_SOLANA_RPC === "1") return DEFAULT_SOLANA_RPC_WS;
  throw new Error("SOLANA_RPC_WS_URL is required for the Solana realtime listener.");
}

function laserstreamConfigFromEnv() {
  const apiKey = String(process.env.HELIUS_API_KEY || "").trim();
  if (!apiKey) throw new Error("HELIUS_API_KEY is required for SOLANA_STREAM_MODE=laserstream-grpc");
  return {
    apiKey,
    endpoint: String(process.env.SOLANA_LASERSTREAM_ENDPOINT || DEFAULT_LASERSTREAM_ENDPOINT).trim(),
    replay: true,
    maxReconnectAttempts: Number(process.env.LASERSTREAM_MAX_RECONNECT_ATTEMPTS || 50),
  };
}

function webhooksFromEnv() {
  return [process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2].filter(
    (url) => url && url.startsWith("https://")
  );
}

async function readState() {
  const direct = await readJsonFile(statePath, null);
  if (direct) return { ...emptyState(), ...direct };
  return { ...emptyState(), ...(await readJsonFile(legacyStatePath, {})) };
}

async function writeState(state) {
  await writeJsonFile(statePath, state);
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
    throw new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + res.status + " non-json");
  }
  if (!res.ok) throw new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + res.status);
  return body;
}

async function notify(webhooks, payload) {
  const body = JSON.stringify(payload);
  for (const url of webhooks) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body,
      });
      if ([200, 204].includes(res.status)) break;
      const responseBody = await res.text();
      if (res.status === 429 && attempt < 5) {
        let wait = 1;
        try { wait = Number(JSON.parse(responseBody).retry_after) || 1; } catch {}
        await sleep(Math.min(Math.max(wait, 0.3), 8) * 1000 + 150);
        continue;
      }
      throw new Error("Discord " + res.status + " " + responseBody.slice(0, 120));
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
        logJson("solana_stock_catalog", {
          count: Object.keys(value).length,
          refreshedAt: new Date(refreshedAt).toISOString(),
        });
      }
      return value;
    },
  };
}

function makeBudgetChecker(budgetGuard) {
  let lastChecked = 0;
  return async ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastChecked < BUDGET_CHECK_MS) return null;
    const result = await budgetGuard.check({ force });
    lastChecked = now;
    return result;
  };
}

function alertAllowed(meta, address) {
  return isInterestingSolanaAsset({ address, symbol: meta.symbol }, interestingOptions);
}

async function postStatusAlert(hooks, status) {
  if (!hooks.length) return false;
  try {
    await notify(hooks, { username: "stock pair alerts", embeds: [buildStatusEmbed(status)] });
    return true;
  } catch (err) {
    console.warn("status notify failed:", err.message);
    return false;
  }
}

async function checkBudgetAndWarn(checkBudget, hooks) {
  const budget = await checkBudget();
  if (!budget?.crossedThreshold) return budget;
  warnJson("budget_threshold_crossed", {
    threshold: budget.crossedThreshold,
    estimatedUsd: budget.estimatedUsd,
  });
  await postStatusAlert(hooks, {
    title: "Infrastructure budget threshold crossed",
    level: "warn",
    service: "solana",
    message: "Configured provider spend crossed " + Math.round(budget.crossedThreshold * 100) + "% of the weekly cap.",
    fields: [
      { name: "Estimated spend", value: "$" + Number(budget.estimatedUsd || 0).toFixed(2), inline: true },
      { name: "Budget", value: "$" + Number(budget.weeklyBudgetUsd || 0).toFixed(2), inline: true },
    ],
  });
  return budget;
}

async function handlePumpCreate(context) {
  const { event, signature, slot, stockCache, hooks, decisionEngine, heartbeat, trace, rickAutoScan } = context;
  if (!event?.mint || !event?.quoteMint || !signature) return context.state;
  if ((context.state.pumpStockLaunches || []).includes(signature)) return context.state;

  let stockMap = await stockCache.get();
  let quote = stockMap[event.quoteMint];
  if (!quote && !NATIVE_QUOTE_MINTS.has(event.quoteMint)) {
    stockMap = await stockCache.get({ force: true });
    quote = stockMap[event.quoteMint];
  }
  if (!quote) return context.state;

  const launch = { ...event, signature, slot };
  const applied = applyPumpStockLaunches(context.state, [launch], { stockMap, allowAlerts: true });
  const next = {
    ...context.state,
    initialized: true,
    pumpStockLaunches: applied.pumpStockLaunches,
    pumpLastSlot: Math.max(Number(context.state.pumpLastSlot || 0), Number(slot || 0)),
    pumpLastSignature: signature,
  };
  if (!applied.alerts.length || !alertAllowed(quote, event.quoteMint)) return next;

  const alert = {
    chain: "solana",
    platform: "Pump.fun",
    projectAddress: event.mint,
    projectSymbol: event.symbol,
    projectName: event.name,
    quotes: [{ ...quote, address: event.quoteMint }],
    tx: signature,
    extra: "Pump CreateEvent used a tracked Solana stock mint as its quote asset.",
  };
  await decisionEngine.evaluate(alert, { receivedToDecisionMs: trace.elapsedMs() });
  console.log(JSON.stringify({ alert }));
  if (!hooks.length) {
    console.warn("alert ready but DISCORD_WEBHOOK_URL is not set");
    return next;
  }
  try {
    await notify(hooks, buildDiscordAlertPayload(alert, { rickAutoScan }));
    heartbeat.alert();
    trace.mark("alert_sent");
  } catch (err) {
    console.warn("notify failed:", err.message);
  }
  return next;
}

async function initializeRuntime({ streamMode, streamUrl, hooks, stockCache, checkBudget, rickAutoScan }) {
  const state = await readState();
  await stockCache.get();
  await writeState(state);
  await checkBudgetAndWarn(() => checkBudget({ force: true }), hooks);
  logJson("listener_start", {
    mode: "solana-realtime",
    streamMode,
    streamUrl: redactUrl(streamUrl),
    protocols: ["pump"],
    hasWebhook: hooks.length > 0,
    rickAutoScan,
    statePath,
  });
  return state;
}

async function runWebSocketConnection(context) {
  const { wsUrl, stockCache, hooks, checkBudget, heartbeat, decisionEngine, rickAutoScan } = context;
  let state = await initializeRuntime({
    streamMode: "standard-wss",
    streamUrl: wsUrl,
    hooks,
    stockCache,
    checkBudget,
    rickAutoScan,
  });
  let nextId = 1;
  const checkpoint = {
    slot: Number(state.pumpLastSlot || 0),
    signature: String(state.pumpLastSignature || ""),
  };
  const snapshot = () => ({
    ...state,
    pumpLastSlot: checkpoint.slot,
    pumpLastSignature: checkpoint.signature,
  });
  const writer = makeCheckpointWriter(snapshot);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    let settled = false;
    let processing = Promise.resolve();
    const heartbeatTimer = setInterval(() => {
      void heartbeat.tick().catch((err) => console.warn("heartbeat failed:", err.message));
    }, HEARTBEAT_MS).unref();
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 60_000).unref();

    function finish(err) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      clearInterval(pingTimer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    }

    ws.on("open", () => {
      void heartbeat.tick({ force: true }).catch((err) => console.warn("heartbeat failed:", err.message));
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }],
      }));
    });

    ws.on("message", (data) => {
      heartbeat.message();
      const receivedNs = process.hrtime.bigint();
      try {
        const msg = JSON.parse(String(data));
        if (msg.id && msg.result) {
          console.log(JSON.stringify({ subscribed: "pump", subscription: msg.result }));
          return;
        }
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        const value = msg.params?.result?.value;
        const slot = msg.params?.result?.context?.slot;
        if (!value) return;
        if (Number(slot || 0) >= checkpoint.slot) {
          checkpoint.slot = Number(slot || 0);
          checkpoint.signature = value.signature || checkpoint.signature;
          writer.schedule();
        }
        if (value.err || !isPumpCreateLog(value.logs)) return;
        const event = decodePumpCreateEvent(value.logs);
        if (!event) return;
        heartbeat.event();
        const trace = createLatencyTrace({
          chain: "solana",
          platform: "Pump.fun",
          signature: value.signature,
          slot,
          source: "standard-wss",
        });
        trace.mark("received", { providerToHandlerMs: Number(msSince(receivedNs).toFixed(3)) });
        processing = processing.then(async () => {
          await checkBudgetAndWarn(checkBudget, hooks);
          state = await handlePumpCreate({
            state: snapshot(),
            event,
            signature: value.signature,
            slot,
            stockCache,
            hooks,
            decisionEngine,
            heartbeat,
            trace,
            rickAutoScan,
          });
          await writer.flush();
          trace.done("handled");
          await heartbeat.tick();
        });
        void processing.catch((err) => {
          heartbeat.error();
          trace.done("error", { error: err.message });
          console.warn("message handling failed:", err.stack || err.message);
          finish(err);
        });
      } catch (err) {
        heartbeat.error();
        console.warn("message handling failed:", err.stack || err.message);
      }
    });

    ws.on("ping", () => ws.pong());
    ws.on("error", (err) => console.warn("websocket error:", err.message));
    ws.on("close", (code, reason) => {
      console.warn("websocket closed:", code, reason.toString());
      void processing
        .then(() => writer.flush())
        .then(() => finish(), (err) => finish(err));
    });
  });
}

function makeCheckpointWriter(getSnapshot) {
  let timer = null;
  let writing = Promise.resolve();

  function write() {
    writing = writing.catch(() => {}).then(() => writeState(getSnapshot()));
    return writing;
  }

  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void write().catch((err) => console.warn("Solana checkpoint write failed:", err.message));
      }, STATE_FLUSH_MS);
      timer.unref();
    },
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await write();
    },
  };
}

async function runLaserstreamConnection(context) {
  const { stockCache, hooks, checkBudget, heartbeat, decisionEngine, rickAutoScan } = context;
  const config = laserstreamConfigFromEnv();
  let state = await initializeRuntime({
    streamMode: "laserstream-grpc",
    streamUrl: config.endpoint,
    hooks,
    stockCache,
    checkBudget,
    rickAutoScan,
  });
  const checkpoint = {
    slot: Number(state.pumpLastSlot || 0),
    signature: String(state.pumpLastSignature || ""),
  };
  const snapshot = () => ({
    ...state,
    pumpLastSlot: checkpoint.slot,
    pumpLastSignature: checkpoint.signature,
  });
  const writer = makeCheckpointWriter(snapshot);
  let processing = Promise.resolve();
  const fromSlot = checkpoint.slot > 0 ? Math.max(0, checkpoint.slot - REPLAY_OVERLAP_SLOTS) : undefined;
  const request = {
    transactions: {
      pump: {
        accountInclude: [PUMP_PROGRAM],
        accountExclude: [],
        accountRequired: [],
        vote: false,
        failed: false,
      },
    },
    commitment: CommitmentLevel.PROCESSED,
    accounts: {},
    slots: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ...(fromSlot === undefined ? {} : { fromSlot }),
  };

  let streamHandle = null;
  let terminalSettled = false;
  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const settleTerminal = (err) => {
    if (terminalSettled) return;
    terminalSettled = true;
    streamHandle?.cancel();
    if (err) rejectTerminal(err);
    else resolveTerminal();
  };
  streamHandle = await subscribe(config, request, async (update) => {
    const transactionUpdate = update?.transaction;
    const info = transactionUpdate?.transaction;
    if (!transactionUpdate || !info) return;
    heartbeat.message();
    const receivedNs = process.hrtime.bigint();
    const slot = Number(transactionUpdate.slot || 0);
    const signature = info.signature?.length ? bs58.encode(info.signature) : "";
    const logs = info.meta?.logMessages || [];
    const event = signature && isPumpCreateLog(logs) ? decodePumpCreateEvent(logs) : null;
    const trace = event ? createLatencyTrace({
      chain: "solana",
      platform: "Pump.fun",
      signature,
      slot,
      source: "laserstream-grpc",
    }) : null;
    if (trace) {
      heartbeat.event();
      trace.mark("received", { providerToHandlerMs: Number(msSince(receivedNs).toFixed(3)) });
    }
    processing = processing.then(async () => {
      if (event) {
        await checkBudgetAndWarn(checkBudget, hooks);
        state = await handlePumpCreate({
          state: snapshot(),
          event,
          signature,
          slot,
          stockCache,
          hooks,
          decisionEngine,
          heartbeat,
          trace,
          rickAutoScan,
        });
      }
      if (slot >= checkpoint.slot) {
        checkpoint.slot = slot;
        checkpoint.signature = signature || checkpoint.signature;
      }
      if (event) {
        await writer.flush();
        trace.done("handled");
        await heartbeat.tick();
      } else {
        writer.schedule();
      }
    });
    try {
      await processing;
    } catch (err) {
      heartbeat.error();
      trace?.done("error", { error: err.message });
      if (isBudgetStopError(err)) {
        console.error(err.message);
        process.exitCode = 2;
      } else {
        console.warn("LaserStream handling failed:", err.stack || err.message);
      }
      settleTerminal(err);
    }
  }, async (err) => {
    heartbeat.error();
    console.warn("LaserStream connection error:", err.message);
  });

  logJson("subscribed", { protocol: "pump", streamMode: "laserstream-grpc", fromSlot: fromSlot || null });
  const heartbeatTimer = setInterval(() => {
    void heartbeat.tick().catch((err) => console.warn("heartbeat failed:", err.message));
  }, HEARTBEAT_MS);

  const shutdown = () => settleTerminal();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await terminal;
    await processing;
  } finally {
    clearInterval(heartbeatTimer);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await writer.flush();
  }
}

async function main() {
  if (!enabledProtocols.has("pump")) throw new Error("No Solana protocols enabled. Set SOLANA_WATCH_PROTOCOLS=pump.");
  const httpUrl = solanaHttpUrlFromEnv();
  const wsUrl = solanaWsUrlFromEnv(httpUrl);
  const hooks = webhooksFromEnv();
  const stockCache = makeStockCache();
  const budgetGuard = await createBudgetGuard({ statePath: budgetStatePath, killSwitchPath });
  const checkBudget = makeBudgetChecker(budgetGuard);
  const rickAutoScan = boolEnv("RICK_AUTOSCAN");
  const heartbeat = createHeartbeat({
    service: "solana",
    intervalMs: HEARTBEAT_MS,
    staleMs: STALE_CONNECTION_MS,
    onStale: ({ lastMessageAgeMs, staleMs }) => postStatusAlert(hooks, {
      title: "Solana listener stale",
      level: "warn",
      service: "solana",
      message: "No stream messages observed within the stale threshold.",
      fields: [
        { name: "Last message age ms", value: String(lastMessageAgeMs), inline: true },
        { name: "Threshold ms", value: String(staleMs), inline: true },
      ],
    }),
  });
  const decisionEngine = createDryRunDecisionEngine();

  if (SOLANA_STREAM_MODE === "laserstream-grpc") {
    await runLaserstreamConnection({ stockCache, hooks, checkBudget, heartbeat, decisionEngine, rickAutoScan });
    return;
  }

  if (!["standard-wss", "laserstream-wss"].includes(SOLANA_STREAM_MODE)) {
    throw new Error("Unsupported SOLANA_STREAM_MODE=" + SOLANA_STREAM_MODE + ". Use standard-wss or laserstream-grpc.");
  }
  if (SOLANA_STREAM_MODE === "laserstream-wss") {
    console.warn("SOLANA_STREAM_MODE=laserstream-wss is a legacy alias for standard-wss and has no replay; use laserstream-grpc after upgrading Helius.");
  }
  let attempt = 0;
  for (;;) {
    try {
      await runWebSocketConnection({ wsUrl, stockCache, hooks, checkBudget, heartbeat, decisionEngine, rickAutoScan });
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
