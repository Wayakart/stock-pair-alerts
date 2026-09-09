import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  BASE_CHAIN_ID,
  BASE_POOL_ROUTES,
  BASE_VVV,
  basePoolHistoryRecord,
  buildVvvPoolFilters,
  decodeBasePoolLog,
} from "./base.mjs";
import { createBudgetGuard, isBudgetStopError } from "./budget.mjs";
import { csvSet, decodeAbiString, hexToBigInt, normalizeAddr, redactUrl, toHex } from "./lib.mjs";
import { createHeartbeat, createLatencyTrace, logJson, msSince, warnJson } from "./metrics.mjs";
import { appendJsonLine, readJsonFile, writeJsonFile } from "./state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.resolve(process.env.BASE_STATE_PATH || path.join(root, "state", "base.json"));
const historyPath = path.resolve(process.env.BASE_HISTORY_PATH || path.join(root, "state", "base-events.ndjson"));
const budgetStatePath = path.resolve(process.env.BUDGET_STATE_PATH || path.join(root, "state", "budget.json"));
const killSwitchPath = path.resolve(process.env.KILL_SWITCH_PATH || path.join(root, "state", "KILL_SWITCH"));
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60_000);
const BUDGET_CHECK_MS = Number(process.env.BUDGET_CHECK_MS || 60_000);
const STALE_CONNECTION_MS = Number(process.env.STALE_CONNECTION_MS || 180_000);
const BACKFILL_CHUNK = BigInt(process.env.BASE_BACKFILL_CHUNK || 2_000);
const BACKFILL_OVERLAP_BLOCKS = BigInt(process.env.BASE_BACKFILL_OVERLAP_BLOCKS || 32);
const BOOTSTRAP_LOOKBACK_BLOCKS = BigInt(process.env.BASE_BOOTSTRAP_LOOKBACK_BLOCKS || 100_000);
const MAX_SEEN_POOLS = Number(process.env.BASE_MAX_SEEN_POOLS || 50_000);
const RPC_MIN_INTERVAL_MS = Number(process.env.BASE_RPC_MIN_INTERVAL_MS || 0);
const ERC20_NAME_SELECTOR = "0x06fdde03";
const ERC20_SYMBOL_SELECTOR = "0x95d89b41";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const UA = "stock-pair-alerts/1.7";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRpcAt = 0;

async function throttleRpc() {
  const wait = RPC_MIN_INTERVAL_MS - (Date.now() - lastRpcAt);
  if (wait > 0) await sleep(wait);
  lastRpcAt = Date.now();
}

function boolEnv(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function streamModeFromEnv() {
  const mode = String(process.env.BASE_STREAM_MODE || "standard-wss").trim().toLowerCase();
  if (!["standard-wss", "pending-logs"].includes(mode)) {
    throw new Error("BASE_STREAM_MODE must be standard-wss or pending-logs");
  }
  return mode;
}

function wsUrlFromEnv(mode) {
  const raw = String(process.env.BASE_RPC_WS_URL || "").trim();
  if (raw) {
    if (boolEnv("REQUIRE_QUICKNODE_BASE") && !/\.quiknode\.pro\/?/i.test(raw)) {
      throw new Error("BASE_RPC_WS_URL must be a QuickNode Base WebSocket URL when REQUIRE_QUICKNODE_BASE=1");
    }
    return raw;
  }
  if (!boolEnv("ALLOW_PUBLIC_BASE_RPC")) {
    throw new Error("BASE_RPC_WS_URL is required for the Base realtime listener. Set ALLOW_PUBLIC_BASE_RPC=1 only for local smoke tests.");
  }
  return mode === "pending-logs" ? "wss://mainnet-preconf.base.org" : "wss://mainnet.base.org";
}

function httpUrlFromEnv(wsUrl) {
  const explicit = String(process.env.BASE_RPC_HTTP_URL || "").trim();
  if (explicit) {
    if (boolEnv("REQUIRE_QUICKNODE_BASE") && !/\.quiknode\.pro\/?/i.test(explicit)) {
      throw new Error("BASE_RPC_HTTP_URL must be a QuickNode Base HTTP URL when REQUIRE_QUICKNODE_BASE=1");
    }
    return explicit;
  }
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

function defaultState() {
  return {
    version: 1,
    initialized: false,
    lastBlock: 0,
    seenPools: {},
  };
}

async function httpJson(url, opts = {}) {
  const response = await fetch(url, {
    ...opts,
    headers: { "user-agent": UA, accept: "application/json", ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + response.status + " non-json");
  }
  if (!response.ok) {
    const error = new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + response.status);
    error.status = response.status;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const dateMs = Date.parse(retryAfter);
      error.retryAfterMs = Number.isFinite(seconds)
        ? seconds * 1_000
        : Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
    }
    throw error;
  }
  return body;
}

async function evmRpc(url, method, params) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await throttleRpc();
      const body = await httpJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (body?.error) throw new Error(method + " " + JSON.stringify(body.error));
      return body?.result;
    } catch (err) {
      lastError = err;
      const retryable = err.status === 429 || Number(err.status) >= 500;
      if (attempt >= 6 || !retryable) throw err;
      await sleep(err.retryAfterMs || Math.min(5_000, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

async function evmRpcBatch(url, calls) {
  await throttleRpc();
  const request = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params,
  }));
  const body = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!Array.isArray(body)) throw new Error("RPC batch returned a non-array response");
  const byId = new Map(body.map((item) => [item.id, item]));
  return request.map((item) => {
    const response = byId.get(item.id);
    return response && !response.error ? response.result : null;
  });
}

function decodeRpcUint(value, fallback) {
  try {
    return value && value !== "0x" ? BigInt(value) : fallback;
  } catch {
    return fallback;
  }
}

function makeTokenMetadataCache(httpUrl) {
  const values = new Map();
  return {
    async get(address) {
      const key = normalizeAddr(address);
      if (values.has(key)) return values.get(key);
      let lastError = new Error("metadata unavailable");
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const [nameResult, symbolResult, decimalsResult] = await evmRpcBatch(httpUrl, [
            { method: "eth_call", params: [{ to: key, data: ERC20_NAME_SELECTOR }, "latest"] },
            { method: "eth_call", params: [{ to: key, data: ERC20_SYMBOL_SELECTOR }, "latest"] },
            { method: "eth_call", params: [{ to: key, data: ERC20_DECIMALS_SELECTOR }, "latest"] },
          ]);
          const metadata = {
            name: decodeAbiString(nameResult),
            symbol: decodeAbiString(symbolResult),
            decimals: Number(decodeRpcUint(decimalsResult, 18n)),
          };
          if (metadata.name || metadata.symbol) values.set(key, metadata);
          return metadata;
        } catch (err) {
          lastError = err;
          if (attempt < 6) await sleep(Math.min(1_000, 100 * 2 ** (attempt - 1)));
        }
      }
      warnJson("base_metadata_failed", { address: key, error: lastError.message });
      return {};
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

function pruneSeenPools(seenPools) {
  const entries = Object.entries(seenPools || {});
  if (entries.length <= MAX_SEEN_POOLS) return seenPools || {};
  entries.sort((left, right) => String(left[1]?.observedAt || "").localeCompare(String(right[1]?.observedAt || "")));
  return Object.fromEntries(entries.slice(entries.length - MAX_SEEN_POOLS));
}

async function processPoolLog({ state, route, log, metadataCache, source, heartbeat }) {
  const event = decodeBasePoolLog(route, log);
  if (!event) return state;
  if (event.removed) {
    if (!state.seenPools?.[event.key]) return state;
    const nextSeen = { ...(state.seenPools || {}) };
    delete nextSeen[event.key];
    const record = basePoolHistoryRecord(event, state.seenPools[event.key], source);
    await appendJsonLine(historyPath, record);
    logJson("base_vvv_pool_removed", {
      source,
      protocol: event.protocol,
      key: event.key,
      counterpartAddress: event.counterpartAddress,
      tx: event.tx,
    });
    return { ...state, seenPools: nextSeen };
  }
  const existing = state.seenPools?.[event.key];
  if (existing) {
    if (source === "preconfirmation" || existing.confirmedAt) return state;
    const confirmedAt = new Date().toISOString();
    const confirmed = {
      ...existing,
      confirmedAt,
      confirmedBlock: event.block,
      confirmedTx: event.tx,
    };
    const confirmation = {
      ...basePoolHistoryRecord(event, {
        symbol: existing.counterpartSymbol,
        name: existing.counterpartName,
        decimals: existing.counterpartDecimals,
      }, source),
      type: "base_vvv_pool_confirmed",
      firstObservedAt: existing.observedAt,
      confirmedAt,
    };
    await appendJsonLine(historyPath, confirmation);
    logJson("base_vvv_pool_confirmed", {
      source,
      protocol: event.protocol,
      key: event.key,
      counterpartAddress: event.counterpartAddress,
      tx: event.tx,
      block: event.block,
    });
    return {
      ...state,
      lastBlock: Math.max(Number(state.lastBlock || 0), Number(event.block || 0)),
      seenPools: { ...state.seenPools, [event.key]: confirmed },
    };
  }

  const rawRecord = basePoolHistoryRecord(event, {}, source);
  if (source !== "preconfirmation") {
    rawRecord.confirmedAt = rawRecord.observedAt;
    rawRecord.confirmedBlock = event.block;
    rawRecord.confirmedTx = event.tx;
  }
  await appendJsonLine(historyPath, rawRecord);
  let nextState = {
    ...state,
    seenPools: pruneSeenPools({ ...(state.seenPools || {}), [event.key]: rawRecord }),
    lastBlock: Math.max(Number(state.lastBlock || 0), Number(event.block || 0)),
  };
  await writeJsonFile(statePath, nextState);
  heartbeat.event();
  logJson("base_vvv_pool_created", {
    source,
    protocol: event.protocol,
    key: event.key,
    counterpartAddress: event.counterpartAddress,
    tx: event.tx,
    block: event.block,
  });

  const metadata = await metadataCache.get(event.counterpartAddress);
  if (!metadata.name && !metadata.symbol) return nextState;
  const enriched = {
    ...basePoolHistoryRecord(event, metadata, source),
    confirmedAt: nextState.seenPools[event.key]?.confirmedAt || null,
    confirmedBlock: nextState.seenPools[event.key]?.confirmedBlock ?? null,
    confirmedTx: nextState.seenPools[event.key]?.confirmedTx || null,
  };
  nextState = {
    ...nextState,
    seenPools: { ...nextState.seenPools, [event.key]: enriched },
  };
  await appendJsonLine(historyPath, { ...enriched, type: "base_vvv_pool_enriched" });
  await writeJsonFile(statePath, nextState);
  return nextState;
}

function compareLogs(left, right) {
  const block = Number(hexToBigInt(left.log.blockNumber)) - Number(hexToBigInt(right.log.blockNumber));
  if (block) return block;
  return Number(hexToBigInt(left.log.logIndex)) - Number(hexToBigInt(right.log.logIndex));
}

async function getVvvLogs(httpUrl, routes, fromBlock, toBlock) {
  const found = new Map();
  for (let start = fromBlock; start <= toBlock; start += BACKFILL_CHUNK) {
    const end = start + BACKFILL_CHUNK - 1n > toBlock ? toBlock : start + BACKFILL_CHUNK - 1n;
    for (const route of routes) {
      for (const filter of buildVvvPoolFilters(route)) {
        const logs = await evmRpc(httpUrl, "eth_getLogs", [{
          ...filter,
          fromBlock: toHex(start),
          toBlock: toHex(end),
        }]);
        for (const log of logs || []) {
          const key = String(log.transactionHash || "") + ":" + String(log.logIndex || "");
          found.set(route.id + ":" + key, { route, log });
        }
      }
    }
  }
  return [...found.values()].sort(compareLogs);
}

async function runBackfill({ state, httpUrl, routes, metadataCache, heartbeat }) {
  const latest = hexToBigInt(await evmRpc(httpUrl, "eth_blockNumber", []));
  const checkpoint = BigInt(state.lastBlock || 0);
  const fromBlock = checkpoint > 0n
    ? (checkpoint >= BACKFILL_OVERLAP_BLOCKS ? checkpoint - BACKFILL_OVERLAP_BLOCKS + 1n : 0n)
    : (latest >= BOOTSTRAP_LOOKBACK_BLOCKS ? latest - BOOTSTRAP_LOOKBACK_BLOCKS + 1n : 0n);
  const logs = await getVvvLogs(httpUrl, routes, fromBlock, latest);
  let nextState = state;
  for (const item of logs) {
    nextState = await processPoolLog({
      state: nextState,
      route: item.route,
      log: item.log,
      metadataCache,
      source: "backfill",
      heartbeat,
    });
  }
  nextState = { ...nextState, initialized: true, lastBlock: Number(latest) };
  await writeJsonFile(statePath, nextState);
  logJson("base_backfill", {
    fromBlock: Number(fromBlock),
    toBlock: Number(latest),
    logs: logs.length,
    pools: Object.keys(nextState.seenPools || {}).length,
  });
  return nextState;
}

async function runConnection({ wsUrl, httpUrl, mode, routes, metadataCache, checkBudget, heartbeat }) {
  let state = { ...defaultState(), ...(await readJsonFile(statePath, {})) };
  let processing = Promise.resolve();
  let nextId = 1;
  const subscriptionTypes = mode === "pending-logs" ? ["pendingLogs", "logs"] : ["logs"];
  const expectedSubscriptions = routes.length * 2 * subscriptionTypes.length;

  await checkBudget();
  const chainId = Number(hexToBigInt(await evmRpc(httpUrl, "eth_chainId", [])));
  if (chainId !== BASE_CHAIN_ID) throw new Error("BASE_RPC_HTTP_URL returned chain id " + chainId + ", expected " + BASE_CHAIN_ID);
  logJson("base_listener_start", {
    mode,
    wsUrl: redactUrl(wsUrl),
    httpUrl: redactUrl(httpUrl),
    vvvAddress: BASE_VVV,
    protocols: routes.map((route) => route.id),
    discordAlertsEnabled: false,
    statePath,
    historyPath,
  });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000 });
    const requests = new Map();
    const subscriptions = new Map();
    let acknowledged = 0;
    let backfillStarted = false;
    let settled = false;
    let budgetCheckRunning = false;
    let socketError = null;

    const heartbeatTimer = setInterval(() => {
      void heartbeat.tick({ force: true }).catch((err) => warnJson("base_heartbeat_failed", { error: err.message }));
    }, HEARTBEAT_MS).unref();
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 60_000).unref();
    const budgetTimer = setInterval(() => {
      if (budgetCheckRunning) return;
      budgetCheckRunning = true;
      void checkBudget()
        .catch((err) => {
          heartbeat.error();
          finish(err);
        })
        .finally(() => {
          budgetCheckRunning = false;
        });
    }, BUDGET_CHECK_MS).unref();

    function finish(err) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      clearInterval(pingTimer);
      clearInterval(budgetTimer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    }

    function enqueue(task) {
      processing = processing.then(task);
      void processing.catch((err) => {
        heartbeat.error();
        warnJson("base_ordered_handler_failed", { error: err.stack || err.message });
        finish(err);
      });
    }

    function subscribe(route, filter, subscriptionType) {
      const id = nextId++;
      requests.set(id, { route, subscriptionType });
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: [subscriptionType, filter],
      }));
    }

    ws.on("open", () => {
      void heartbeat.tick({ force: true });
      for (const route of routes) {
        for (const filter of buildVvvPoolFilters(route)) {
          for (const subscriptionType of subscriptionTypes) subscribe(route, filter, subscriptionType);
        }
      }
    });

    ws.on("message", (data) => {
      heartbeat.message();
      const receivedNs = process.hrtime.bigint();
      try {
        const message = JSON.parse(String(data));
        if (message.id !== undefined && requests.has(message.id)) {
          const request = requests.get(message.id);
          requests.delete(message.id);
          if (message.error) throw new Error("subscribe " + request.route.id + " " + JSON.stringify(message.error));
          const subscriptionId = String(message.result || "");
          if (!subscriptionId) throw new Error("subscribe " + request.route.id + " returned no subscription id");
          subscriptions.set(subscriptionId, request);
          acknowledged += 1;
          if (acknowledged === expectedSubscriptions && !backfillStarted) {
            backfillStarted = true;
            enqueue(async () => {
              state = await runBackfill({ state, httpUrl, routes, metadataCache, heartbeat });
            });
          }
          return;
        }
        if (message.error) throw new Error(JSON.stringify(message.error));
        const subscription = subscriptions.get(String(message.params?.subscription || ""));
        const log = message.params?.result;
        if (!subscription || !log) return;
        const { route, subscriptionType } = subscription;
        const source = subscriptionType === "pendingLogs" ? "preconfirmation" : "live";
        const trace = createLatencyTrace({
          chain: "base",
          platform: route.venue,
          tx: log.transactionHash,
          block: Number(hexToBigInt(log.blockNumber)),
          source,
        });
        trace.mark("received", { providerToHandlerMs: Number(msSince(receivedNs).toFixed(3)) });
        enqueue(async () => {
          state = await processPoolLog({
            state,
            route,
            log,
            metadataCache,
            source,
            heartbeat,
          });
          await writeJsonFile(statePath, state);
          trace.done("recorded");
        });
      } catch (err) {
        heartbeat.error();
        warnJson("base_message_failed", { error: err.stack || err.message });
        finish(err);
      }
    });

    ws.on("ping", () => ws.pong());
    ws.on("pong", () => heartbeat.message());
    ws.on("error", (err) => {
      socketError = err;
      warnJson("base_websocket_error", { error: err.message });
    });
    ws.on("close", (code, reason) => {
      warnJson("base_websocket_closed", { code, reason: reason.toString() });
      const closeError = socketError || new Error("Base WebSocket closed with code " + code);
      void processing.then(() => finish(closeError), (err) => finish(err));
    });
  });
}

async function main() {
  const backfillOnly = process.argv.includes("--backfill-only");
  const mode = streamModeFromEnv();
  const hasExplicitHttpUrl = Boolean(String(process.env.BASE_RPC_HTTP_URL || "").trim());
  const wsUrl = backfillOnly && hasExplicitHttpUrl ? "" : wsUrlFromEnv(mode);
  const httpUrl = httpUrlFromEnv(wsUrl);
  const enabledProtocols = csvSet(process.env.BASE_WATCH_PROTOCOLS || "uniswap-v4,uniswap-v3,uniswap-v2,aerodrome,aerodrome-slipstream");
  const routes = BASE_POOL_ROUTES.filter((route) => enabledProtocols.has(route.id));
  if (!routes.length) throw new Error("No Base protocols enabled in BASE_WATCH_PROTOCOLS");
  const budgetGuard = await createBudgetGuard({ statePath: budgetStatePath, killSwitchPath });
  const checkBudget = makeBudgetChecker(budgetGuard);
  const metadataCache = makeTokenMetadataCache(httpUrl);
  const heartbeat = createHeartbeat({ service: "base", intervalMs: HEARTBEAT_MS, staleMs: STALE_CONNECTION_MS });
  await checkBudget({ force: true });
  if (backfillOnly) {
    const chainId = Number(hexToBigInt(await evmRpc(httpUrl, "eth_chainId", [])));
    if (chainId !== BASE_CHAIN_ID) throw new Error("BASE_RPC_HTTP_URL returned chain id " + chainId + ", expected " + BASE_CHAIN_ID);
    const state = { ...defaultState(), ...(await readJsonFile(statePath, {})) };
    await runBackfill({ state, httpUrl, routes, metadataCache, heartbeat });
    return;
  }
  let attempt = 0;
  for (;;) {
    try {
      await runConnection({ wsUrl, httpUrl, mode, routes, metadataCache, checkBudget, heartbeat });
    } catch (err) {
      if (isBudgetStopError(err)) {
        console.error("base realtime listener stopped:", err.message);
        process.exit(2);
      }
      attempt += 1;
      warnJson("base_listener_failed", { error: err.stack || err.message, attempt });
    }
    const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
    await sleep(wait);
  }
}

main().catch((err) => {
  if (isBudgetStopError(err)) {
    console.error("base realtime listener stopped:", err.message);
  } else {
    console.error(err.stack || err.message);
  }
  process.exit(isBudgetStopError(err) ? 2 : 1);
});
