import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createDryRunDecisionEngine } from "./decision.mjs";
import {
  PONS_FACTORY,
  TOPIC0_APPROVAL,
  LONG_LAUNCHER,
  TOPIC0_LAUNCH,
  FLAP_ROUTER,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  PAIR_COORDINATOR,
  TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED,
  RH_ASSETS_URL,
  decodeApprovalLog,
  decodeLaunchLog,
  decodeFlapQuoteSetLog,
  decodePairCanonicalPoolLog,
  decodePairCanonicalProjectLog,
  decodeAbiString,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  applyFlapQuoteLogs,
  applyPairLaunches,
  buildDiscordAlertPayload,
  buildStatusEmbed,
  emptyState,
  csvSet,
  isInterestingAsset,
  normalizeAddr,
  redactUrl,
  hexToBigInt,
  toHex,
} from "./lib.mjs";
import { createHeartbeat, createLatencyTrace, logJson, msSince } from "./metrics.mjs";
import { readJsonFile, writeJsonFile } from "./state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyStatePath = path.join(root, "state", "seen.json");
const statePath = path.join(root, "state", "robinhood.json");
const UA = "stock-pair-alerts/1.6";
const DEFAULT_WS = "wss://rpc-robinhood.blockmachine.io";
const RH_REFRESH_MS = Number(process.env.RH_REFRESH_MS || 300_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60_000);
const STALE_CONNECTION_MS = Number(process.env.STALE_CONNECTION_MS || 180_000);
const BACKFILL_CHUNK = BigInt(process.env.EVM_BACKFILL_CHUNK || 2_000);
const BACKFILL_OVERLAP_BLOCKS = BigInt(process.env.EVM_BACKFILL_OVERLAP_BLOCKS || 32);
const BOOTSTRAP_LOOKBACK_BLOCKS = BigInt(process.env.EVM_BOOTSTRAP_LOOKBACK_BLOCKS || 100_000);
const ERC20_NAME_SELECTOR = "0x06fdde03";
const ERC20_SYMBOL_SELECTOR = "0x95d89b41";

const protocols = [
  {
    id: "pons",
    platform: "Pons",
    address: PONS_FACTORY,
    topic0: TOPIC0_APPROVAL,
    decode: decodeApprovalLog,
    checkpoint: "ponsLastBlock",
  },
  {
    id: "long",
    platform: "Long",
    address: LONG_LAUNCHER,
    topic0: TOPIC0_LAUNCH,
    decode: decodeLaunchLog,
    checkpoint: "longLastBlock",
  },
  {
    id: "flap",
    platform: "Flap",
    address: FLAP_ROUTER,
    topic0: TOPIC0_FLAP_TOKEN_QUOTE_SET,
    decode: decodeFlapQuoteSetLog,
    checkpoint: "flapLastBlock",
  },
  {
    id: "pair",
    platform: "Pair",
    address: PAIR_COORDINATOR,
    topic0: TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED,
    decode: decodePairCanonicalProjectLog,
    checkpoint: "pairLastBlock",
  },
];

const enabledProtocols = csvSet(process.env.WATCH_PROTOCOLS || "pons,long,flap,pair");
const includeSymbols = csvSet(process.env.INTERESTING_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const excludeSymbols = csvSet(process.env.IGNORE_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const includeAddresses = csvSet(process.env.INTERESTING_ADDRESSES, { normalize: normalizeAddr });
const excludeAddresses = csvSet(process.env.IGNORE_ADDRESSES, { normalize: normalizeAddr });
const interestingOptions = { includeSymbols, excludeSymbols, includeAddresses, excludeAddresses };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boolEnv(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function wsUrlFromEnv() {
  const raw = String(process.env.REALTIME_RPC_WS_URL || process.env.RPC_WS_URL || "").trim();
  if (raw) {
    if (boolEnv("REQUIRE_QUICKNODE_ROBINHOOD") && !/\.quiknode\.pro\/?/i.test(raw)) {
      throw new Error("REALTIME_RPC_WS_URL must be a QuickNode Robinhood WebSocket URL when REQUIRE_QUICKNODE_ROBINHOOD=1");
    }
    return raw;
  }
  const rpcUrl = String(process.env.RPC_URL || "").trim();
  if (/^wss?:\/\//i.test(rpcUrl)) return rpcUrl;
  if (boolEnv("ALLOW_PUBLIC_ROBINHOOD_RPC")) return DEFAULT_WS;
  throw new Error("REALTIME_RPC_WS_URL is required for the Robinhood realtime listener. Set ALLOW_PUBLIC_ROBINHOOD_RPC=1 only for local smoke tests.");
}

function httpUrlFromEnv(wsUrl) {
  const explicit = String(process.env.REALTIME_RPC_HTTP_URL || "").trim();
  if (explicit) return explicit;
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

function webhooksFromEnv() {
  return [process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2].filter(
    (url) => url && url.startsWith("https://")
  );
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

async function evmRpc(url, method, params) {
  const body = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body?.error) throw new Error(method + " " + JSON.stringify(body.error));
  return body?.result;
}

async function evmRpcBatch(url, calls) {
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

async function readState() {
  const direct = await readJsonFile(statePath, null);
  if (direct) return { ...emptyState(), ...direct };
  return { ...emptyState(), ...(await readJsonFile(legacyStatePath, {})) };
}

async function writeState(state) {
  await writeJsonFile(statePath, state);
}

async function loadRhAssets() {
  return extractRhAssets(await httpJson(RH_ASSETS_URL));
}

function makeRhCache() {
  let value = {};
  let refreshedAt = 0;
  return {
    async get({ force = false } = {}) {
      const stale = Date.now() - refreshedAt > RH_REFRESH_MS;
      if (force || stale || !Object.keys(value).length) {
        value = await loadRhAssets();
        refreshedAt = Date.now();
        logJson("rh_catalog", { count: Object.keys(value).length, refreshedAt: new Date(refreshedAt).toISOString() });
      }
      return value;
    },
  };
}

function makeTokenMetadataCache(httpUrl) {
  const values = new Map();
  return {
    async get(address) {
      const key = normalizeAddr(address);
      if (values.has(key)) return values.get(key);
      let metadata = {};
      try {
        const [nameResult, symbolResult] = await evmRpcBatch(httpUrl, [
          { method: "eth_call", params: [{ to: key, data: ERC20_NAME_SELECTOR }, "latest"] },
          { method: "eth_call", params: [{ to: key, data: ERC20_SYMBOL_SELECTOR }, "latest"] },
        ]);
        metadata = { name: decodeAbiString(nameResult), symbol: decodeAbiString(symbolResult) };
      } catch (err) {
        console.warn("token metadata lookup failed:", key, err.message);
      }
      values.set(key, metadata);
      return metadata;
    },
  };
}

function alertAllowed(quoteMeta, quoteAddress) {
  return isInterestingAsset({ address: quoteAddress, symbol: quoteMeta.symbol }, interestingOptions);
}

function routeKey(address, topic0) {
  return normalizeAddr(address) + ":" + String(topic0 || "").toLowerCase();
}

function uniqueQuotes(events, rhMap) {
  const seen = new Set();
  const quotes = [];
  for (const event of events) {
    const address = normalizeAddr(event.quote);
    if (!rhMap[address] || seen.has(address)) continue;
    seen.add(address);
    quotes.push({ ...rhMap[address], address });
  }
  return quotes;
}

async function sendAlert({ hooks, alert, decisionEngine, trace, heartbeat, rickAutoScan }) {
  await decisionEngine.evaluate(alert, { receivedToDecisionMs: trace.elapsedMs() });
  console.log(JSON.stringify({ alert }));
  if (!hooks.length) {
    console.warn("alert ready but DISCORD_WEBHOOK_URL is not set");
    return;
  }
  try {
    await notify(hooks, buildDiscordAlertPayload(alert, { rickAutoScan }));
    heartbeat?.alert();
    trace.mark("alert_sent");
  } catch (err) {
    console.warn("notify failed:", err.message);
  }
}

async function handlePonsLog(context) {
  const { state, log, rhCache, allowAlerts } = context;
  const event = decodeApprovalLog(log);
  if (!event) return state;
  context.trace.mark("decoded", { platform: "Pons", block: event.block });
  const base = { ...state, initialized: allowAlerts ? true : state.initialized };
  const pons = applyPonsLogs(base, [event], { allowAlerts });
  const next = { ...base, ponsLastBlock: pons.ponsLastBlock, ponsApproved: pons.ponsApproved };
  if (!pons.alerts.length) return next;

  let rhMap = await rhCache.get();
  let meta = rhMap[event.pairToken] || {};
  if (!meta.symbol) {
    rhMap = await rhCache.get({ force: true });
    meta = rhMap[event.pairToken] || {};
  }
  if (!alertAllowed(meta, event.pairToken)) return next;
  await sendAlert({
    ...context,
    alert: {
      chain: "robinhood",
      platform: "Pons",
      verb: "approved",
      projectAddress: event.pairToken,
      projectSymbol: meta.symbol,
      projectName: meta.name,
      quotes: [],
      tx: event.tx,
    },
  });
  return next;
}

async function handleLongLog(context) {
  const { state, log, rhCache, tokenCache, allowAlerts } = context;
  const event = decodeLaunchLog(log);
  if (!event) return state;
  context.trace.mark("decoded", { platform: "Long", block: event.block });
  let rhMap = await rhCache.get();
  let applied = applyLongLogs(state, [event], { rhMap, allowAlerts });
  if (allowAlerts && !applied.alerts.length && !rhMap[event.numeraire]) {
    rhMap = await rhCache.get({ force: true });
    applied = applyLongLogs(state, [event], { rhMap, allowAlerts });
  }
  const next = {
    ...state,
    initialized: allowAlerts ? true : state.initialized,
    longReady: true,
    longLastBlock: applied.longLastBlock,
    longLaunches: applied.longLaunches,
    longNumeraires: applied.longNumeraires,
  };
  if (!applied.alerts.length) return next;

  const quote = rhMap[event.numeraire] || {};
  if (!alertAllowed(quote, event.numeraire)) return next;
  const project = await tokenCache.get(event.asset);
  await sendAlert({
    ...context,
    alert: {
      chain: "robinhood",
      platform: "Long",
      projectAddress: event.asset,
      projectSymbol: project.symbol,
      projectName: project.name,
      quotes: [{ ...quote, address: event.numeraire }],
      tx: event.tx,
    },
  });
  return next;
}

async function handleFlapLog(context) {
  const { state, log, rhCache, tokenCache, allowAlerts } = context;
  const event = decodeFlapQuoteSetLog(log);
  if (!event) return state;
  context.trace.mark("decoded", { platform: "Flap", block: event.block });
  let rhMap = await rhCache.get();
  let applied = applyFlapQuoteLogs(state, [event], { rhMap, allowAlerts });
  if (allowAlerts && !applied.alerts.length && !rhMap[event.quote]) {
    rhMap = await rhCache.get({ force: true });
    applied = applyFlapQuoteLogs(state, [event], { rhMap, allowAlerts });
  }
  const next = {
    ...state,
    initialized: allowAlerts ? true : state.initialized,
    flapLastBlock: applied.flapLastBlock,
    flapPairs: applied.flapPairs,
  };
  if (!applied.alerts.length) return next;

  const quote = rhMap[event.quote] || {};
  if (!alertAllowed(quote, event.quote)) return next;
  const project = await tokenCache.get(event.token);
  await sendAlert({
    ...context,
    alert: {
      chain: "robinhood",
      platform: "Flap",
      projectAddress: event.token,
      projectSymbol: project.symbol,
      projectName: project.name,
      quotes: [{ ...quote, address: event.quote }],
      tx: event.tx,
    },
  });
  return next;
}

async function pairPoolsFromReceipt(httpUrl, event) {
  const receipt = await evmRpc(httpUrl, "eth_getTransactionReceipt", [event.tx]);
  if (!receipt) throw new Error("Pair launch receipt is not available yet");
  return (receipt.logs || [])
    .filter((log) => normalizeAddr(log.address) === normalizeAddr(PAIR_COORDINATOR))
    .map(decodePairCanonicalPoolLog)
    .filter((pool) => pool && pool.project === event.project);
}

async function handlePairLog(context) {
  const { state, log, rhCache, tokenCache, allowAlerts, httpUrl } = context;
  const event = decodePairCanonicalProjectLog(log);
  if (!event) return state;
  context.trace.mark("decoded", { platform: "Pair", block: event.block });

  if (!allowAlerts) {
    const applied = applyPairLaunches(state, [event], { allowAlerts: false });
    return { ...state, pairLastBlock: applied.pairLastBlock, pairLaunches: applied.pairLaunches };
  }

  let rhMap = await rhCache.get();
  const pools = await pairPoolsFromReceipt(httpUrl, event);
  let quotes = uniqueQuotes(pools, rhMap);
  if (!quotes.length) {
    rhMap = await rhCache.get({ force: true });
    quotes = uniqueQuotes(pools, rhMap);
  }
  const relevant = quotes.some((quote) => alertAllowed(quote, quote.address));
  const applied = applyPairLaunches(state, [event], { allowAlerts: relevant });
  const next = {
    ...state,
    initialized: true,
    pairLastBlock: applied.pairLastBlock,
    pairLaunches: applied.pairLaunches,
  };
  if (!applied.alerts.length) return next;

  const project = await tokenCache.get(event.project);
  await sendAlert({
    ...context,
    alert: {
      chain: "robinhood",
      platform: "Pair",
      projectAddress: event.project,
      projectSymbol: project.symbol,
      projectName: project.name,
      quotes,
      tx: event.tx,
      extra: quotes.length + " Robinhood stock pool" + (quotes.length === 1 ? "" : "s") + " created.",
    },
  });
  return next;
}

async function processLog(context) {
  if (context.protocol.id === "pons") return handlePonsLog(context);
  if (context.protocol.id === "long") return handleLongLog(context);
  if (context.protocol.id === "flap") return handleFlapLog(context);
  if (context.protocol.id === "pair") return handlePairLog(context);
  return context.state;
}

async function getLogsRange(httpUrl, protocol, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += BACKFILL_CHUNK) {
    const end = start + BACKFILL_CHUNK - 1n > toBlock ? toBlock : start + BACKFILL_CHUNK - 1n;
    const page = await evmRpc(httpUrl, "eth_getLogs", [{
      address: protocol.address,
      fromBlock: toHex(start),
      toBlock: toHex(end),
      topics: [protocol.topic0],
    }]);
    logs.push(...(page || []));
  }
  return logs;
}

async function runBackfill(context) {
  const latest = hexToBigInt(await evmRpc(context.httpUrl, "eth_blockNumber", []));
  for (const protocol of context.active) {
    const checkpoint = BigInt(context.state[protocol.checkpoint] || 0);
    const bootstrap = checkpoint === 0n;
    const migratingLong = protocol.id === "long" && !(context.state.longLaunches || []).length && checkpoint > 0n;
    const fromBlock = bootstrap
      ? (latest >= BOOTSTRAP_LOOKBACK_BLOCKS ? latest - BOOTSTRAP_LOOKBACK_BLOCKS + 1n : 0n)
      : (checkpoint >= BACKFILL_OVERLAP_BLOCKS ? checkpoint - BACKFILL_OVERLAP_BLOCKS + 1n : 0n);
    const logs = await getLogsRange(context.httpUrl, protocol, fromBlock, latest);
    for (const log of logs) {
      const trace = createLatencyTrace({
        chain: "robinhood",
        platform: protocol.platform,
        tx: log.transactionHash,
        block: Number(hexToBigInt(log.blockNumber)),
        source: "backfill",
      });
      context.state = await processLog({
        ...context,
        state: context.state,
        protocol,
        log,
        trace,
        allowAlerts: !bootstrap && !(migratingLong && hexToBigInt(log.blockNumber) <= checkpoint),
      });
      trace.done("backfill_handled");
    }
    context.state[protocol.checkpoint] = Math.max(Number(context.state[protocol.checkpoint] || 0), Number(latest));
    logJson("backfill", {
      protocol: protocol.id,
      fromBlock: Number(fromBlock),
      toBlock: Number(latest),
      logs: logs.length,
      bootstrap,
    });
  }
  context.state.initialized = true;
  await writeState(context.state);
  return context.state;
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

async function runConnection({ url, httpUrl, rhCache, tokenCache, hooks, heartbeat, decisionEngine, rickAutoScan }) {
  let state = await readState();
  let nextId = 1;
  let processing = Promise.resolve();
  const byLogKey = new Map();
  const active = protocols.filter((protocol) => enabledProtocols.has(protocol.id));
  if (!active.length) throw new Error("No protocols enabled. Set WATCH_PROTOCOLS=pons,long,flap,pair or add a protocol id.");
  for (const protocol of active) byLogKey.set(routeKey(protocol.address, protocol.topic0), protocol);

  await rhCache.get();
  await writeState(state);
  logJson("listener_start", {
    mode: "realtime",
    url: redactUrl(url),
    httpUrl: redactUrl(httpUrl),
    protocols: active.map((protocol) => protocol.id),
    hasWebhook: hooks.length > 0,
    rickAutoScan,
    statePath,
  });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    let settled = false;
    let subscriptionId = "";
    let backfillStarted = false;
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

    function enqueue(task) {
      processing = processing.then(task);
      void processing.catch((err) => {
        heartbeat.error();
        console.warn("ordered event handling failed:", err.stack || err.message);
        finish(err);
      });
    }

    ws.on("open", () => {
      void heartbeat.tick({ force: true }).catch((err) => console.warn("heartbeat failed:", err.message));
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "eth_subscribe",
        params: ["logs", {
          address: active.map((protocol) => protocol.address),
          topics: [[...new Set(active.map((protocol) => protocol.topic0))]],
        }],
      }));
    });

    ws.on("message", (data) => {
      heartbeat.message();
      const receivedNs = process.hrtime.bigint();
      try {
        const msg = JSON.parse(String(data));
        if (msg.id && msg.result) {
          subscriptionId = msg.result;
          console.log(JSON.stringify({ subscribed: active.map((protocol) => protocol.id), subscription: subscriptionId }));
          if (!backfillStarted) {
            backfillStarted = true;
            enqueue(async () => {
              state = await runBackfill({
                state,
                active,
                httpUrl,
                rhCache,
                tokenCache,
                hooks,
                heartbeat,
                decisionEngine,
                rickAutoScan,
              });
            });
          }
          return;
        }
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        const log = msg.params?.result;
        if (!log || msg.params?.subscription !== subscriptionId) return;
        const protocol = byLogKey.get(routeKey(log.address, log.topics?.[0]));
        if (!protocol) return;
        heartbeat.event();
        const trace = createLatencyTrace({
          chain: "robinhood",
          platform: protocol.platform,
          tx: log.transactionHash,
          block: Number(hexToBigInt(log.blockNumber)),
          source: "live",
        });
        trace.mark("received", { providerToHandlerMs: Number(msSince(receivedNs).toFixed(3)) });
        enqueue(async () => {
          try {
            state = await processLog({
              state,
              protocol,
              log,
              httpUrl,
              rhCache,
              tokenCache,
              hooks,
              heartbeat,
              decisionEngine,
              trace,
              rickAutoScan,
              allowAlerts: true,
            });
            await writeState(state);
            trace.done("handled");
            await heartbeat.tick();
          } catch (err) {
            trace.done("error", { error: err.message });
            throw err;
          }
        });
      } catch (err) {
        heartbeat.error();
        console.warn("message handling failed:", err.stack || err.message);
      }
    });

    ws.on("ping", () => ws.pong());
    ws.on("pong", () => heartbeat.message());
    ws.on("error", (err) => console.warn("websocket error:", err.message));
    ws.on("close", (code, reason) => {
      console.warn("websocket closed:", code, reason.toString());
      void processing.then(() => finish(), (err) => finish(err));
    });
  });
}

async function main() {
  const url = wsUrlFromEnv();
  const httpUrl = httpUrlFromEnv(url);
  const hooks = webhooksFromEnv();
  const rhCache = makeRhCache();
  const tokenCache = makeTokenMetadataCache(httpUrl);
  const rickAutoScan = boolEnv("RICK_AUTOSCAN");
  const heartbeat = createHeartbeat({
    service: "robinhood",
    intervalMs: HEARTBEAT_MS,
    staleMs: STALE_CONNECTION_MS,
    onStale: ({ lastMessageAgeMs, staleMs }) => postStatusAlert(hooks, {
      title: "Robinhood listener stale",
      level: "warn",
      service: "robinhood",
      message: "No WebSocket messages observed within the stale threshold.",
      fields: [
        { name: "Last message age ms", value: String(lastMessageAgeMs), inline: true },
        { name: "Threshold ms", value: String(staleMs), inline: true },
      ],
    }),
  });
  const decisionEngine = createDryRunDecisionEngine();
  let attempt = 0;
  for (;;) {
    try {
      await runConnection({ url, httpUrl, rhCache, tokenCache, hooks, heartbeat, decisionEngine, rickAutoScan });
      attempt += 1;
    } catch (err) {
      attempt += 1;
      console.warn("realtime listener failed:", err.stack || err.message);
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
