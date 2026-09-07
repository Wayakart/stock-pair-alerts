import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  PONS_FACTORY,
  TOPIC0_APPROVAL,
  LONG_LAUNCHER,
  TOPIC0_LAUNCH,
  FLAP_ROUTER,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  PAIR_LAUNCHPAD,
  TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED,
  RH_ASSETS_URL,
  decodeApprovalLog,
  decodeLaunchLog,
  decodeFlapQuoteSetLog,
  decodePairCustomQuotePoolLog,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  applyFlapQuoteLogs,
  applyPairPoolLogs,
  buildEmbed,
  emptyState,
  csvSet,
  isInterestingAsset,
  normalizeAddr,
  redactUrl,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, "state", "seen.json");
const UA = "stock-pair-alerts/1.4";
const DEFAULT_WS = "wss://rpc-robinhood.blockmachine.io";
const RH_REFRESH_MS = Number(process.env.RH_REFRESH_MS || 300_000);

const protocols = [
  {
    id: "pons",
    platform: "Pons",
    address: PONS_FACTORY,
    topic0: TOPIC0_APPROVAL,
    decode: decodeApprovalLog,
  },
  {
    id: "long",
    platform: "Long",
    address: LONG_LAUNCHER,
    topic0: TOPIC0_LAUNCH,
    decode: decodeLaunchLog,
  },
  {
    id: "flap",
    platform: "Flap",
    address: FLAP_ROUTER,
    topic0: TOPIC0_FLAP_TOKEN_QUOTE_SET,
    decode: decodeFlapQuoteSetLog,
  },
  {
    id: "pair",
    platform: "Pair",
    address: PAIR_LAUNCHPAD,
    topic0: TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED,
    decode: decodePairCustomQuotePoolLog,
  },
];

const enabledProtocols = csvSet(process.env.WATCH_PROTOCOLS || "pons,long,flap,pair");
const includeSymbols = csvSet(process.env.INTERESTING_SYMBOLS, { normalize: (v) => v.toUpperCase() });
const excludeSymbols = csvSet(process.env.IGNORE_SYMBOLS, { normalize: (v) => v.toUpperCase() });
const includeAddresses = csvSet(process.env.INTERESTING_ADDRESSES, { normalize: normalizeAddr });
const excludeAddresses = csvSet(process.env.IGNORE_ADDRESSES, { normalize: normalizeAddr });
const interestingOptions = { includeSymbols, excludeSymbols, includeAddresses, excludeAddresses };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (/^wss?:\/\//i.test(rpcUrl)) {
    if (boolEnv("REQUIRE_QUICKNODE_ROBINHOOD") && !/\.quiknode\.pro\/?/i.test(rpcUrl)) {
      throw new Error("RPC_URL must be a QuickNode Robinhood WebSocket URL when REQUIRE_QUICKNODE_ROBINHOOD=1");
    }
    return rpcUrl;
  }
  if (boolEnv("ALLOW_PUBLIC_ROBINHOOD_RPC")) return DEFAULT_WS;
  throw new Error("REALTIME_RPC_WS_URL is required for the Robinhood realtime listener. Set ALLOW_PUBLIC_ROBINHOOD_RPC=1 only for local smoke tests.");
}

function webhooksFromEnv() {
  return [process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2].filter(
    (u) => u && u.startsWith("https://")
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
        console.log(JSON.stringify({ rhCount: Object.keys(value).length, refreshedAt: new Date(refreshedAt).toISOString() }));
      }
      return value;
    },
  };
}

function alertAllowed(meta, address) {
  return isInterestingAsset({ address, symbol: meta.symbol }, interestingOptions);
}

function routeKey(address, topic0) {
  return normalizeAddr(address) + ":" + String(topic0 || "").toLowerCase();
}

async function handlePonsLog({ state, log, rhCache, hooks }) {
  const event = decodeApprovalLog(log);
  if (!event) return state;
  const next = { ...state, initialized: true };
  const pons = applyPonsLogs(next, [event]);
  next.ponsLastBlock = pons.ponsLastBlock;
  next.ponsApproved = pons.ponsApproved;
  if (!pons.alerts.length) return next;

  let rhMap = await rhCache.get();
  let meta = rhMap[event.pairToken] || {};
  if (!meta.symbol) {
    rhMap = await rhCache.get({ force: true });
    meta = rhMap[event.pairToken] || {};
  }
  if (!alertAllowed(meta, event.pairToken)) return next;

  const alert = { platform: "Pons", symbol: meta.symbol, name: meta.name, address: event.pairToken, tx: event.tx };
  await postOrLogAlert(hooks, alert);
  return next;
}

async function handleLongLog({ state, log, rhCache, hooks }) {
  const event = decodeLaunchLog(log);
  if (!event) return state;
  let rhMap = await rhCache.get();
  let long = applyLongLogs(state, [event], { rhMap, allowAlerts: true });
  if (!long.alerts.length) {
    rhMap = await rhCache.get({ force: true });
    long = applyLongLogs(state, [event], { rhMap, allowAlerts: true });
  }

  const next = {
    ...state,
    initialized: true,
    longReady: true,
    longLastBlock: long.longLastBlock,
    longNumeraires: long.longNumeraires,
  };
  if (!long.alerts.length) return next;

  const meta = rhMap[event.numeraire] || {};
  if (!alertAllowed(meta, event.numeraire)) return next;

  const alert = {
    platform: "Long",
    symbol: meta.symbol,
    name: meta.name,
    address: event.numeraire,
    tx: event.tx,
    extra: "First Long pair against this stock.",
  };
  await postOrLogAlert(hooks, alert);
  return next;
}

async function handleFlapLog({ state, log, rhCache, hooks }) {
  const event = decodeFlapQuoteSetLog(log);
  if (!event) return state;
  let rhMap = await rhCache.get();
  let flap = applyFlapQuoteLogs(state, [event], { rhMap, allowAlerts: true });
  if (!flap.alerts.length) {
    rhMap = await rhCache.get({ force: true });
    flap = applyFlapQuoteLogs(state, [event], { rhMap, allowAlerts: true });
  }

  const next = {
    ...state,
    initialized: true,
    flapLastBlock: flap.flapLastBlock,
    flapPairs: flap.flapPairs,
  };
  if (!flap.alerts.length) return next;

  const meta = rhMap[event.quote] || {};
  if (!alertAllowed(meta, event.quote)) return next;

  const alert = {
    platform: "Flap",
    symbol: meta.symbol,
    name: meta.name,
    address: event.quote,
    tx: event.tx,
    extra: "Flap token configured a Robinhood stock quote pair. Token: `" + event.token + "`",
  };
  await postOrLogAlert(hooks, alert);
  return next;
}

async function handlePairLog({ state, log, rhCache, hooks }) {
  const event = decodePairCustomQuotePoolLog(log);
  if (!event) return state;
  let rhMap = await rhCache.get();
  let pair = applyPairPoolLogs(state, [event], { rhMap, allowAlerts: true });
  if (!pair.alerts.length) {
    rhMap = await rhCache.get({ force: true });
    pair = applyPairPoolLogs(state, [event], { rhMap, allowAlerts: true });
  }

  const next = {
    ...state,
    initialized: true,
    pairLastBlock: pair.pairLastBlock,
    pairPools: pair.pairPools,
  };
  if (!pair.alerts.length) return next;

  const meta = rhMap[event.quote] || {};
  if (!alertAllowed(meta, event.quote)) return next;

  const alert = {
    platform: "Pair",
    symbol: meta.symbol,
    name: meta.name,
    address: event.quote,
    tx: event.tx,
    extra: "Pair Fund launched a custom Robinhood stock quote pool. Project: `" + event.project + "`",
  };
  await postOrLogAlert(hooks, alert);
  return next;
}

async function postOrLogAlert(hooks, alert) {
  console.log(JSON.stringify({ alert }));
  if (!hooks.length) {
    console.warn("alert ready but DISCORD_WEBHOOK_URL is not set");
    return;
  }
  try {
    await notify(hooks, buildEmbed(alert));
  } catch (err) {
    console.warn("notify failed:", err.message);
  }
}

async function runConnection({ url, rhCache, hooks }) {
  let state = await readState();
  let nextId = 1;
  const byLogKey = new Map();
  const pendingById = new Map();
  const active = protocols.filter((p) => enabledProtocols.has(p.id));
  if (!active.length) throw new Error("No protocols enabled. Set WATCH_PROTOCOLS=pons,long,flap,pair or add a protocol id.");
  for (const protocol of active) byLogKey.set(routeKey(protocol.address, protocol.topic0), protocol);

  await rhCache.get();
  console.log(JSON.stringify({
    mode: "realtime",
    url: redactUrl(url),
    protocols: active.map((p) => p.id),
    hasWebhook: hooks.length > 0,
    interestingSymbols: [...includeSymbols],
    ignoreSymbols: [...excludeSymbols],
  }));

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      err ? reject(err) : resolve();
    }

    ws.on("open", () => {
      const id = nextId++;
      pendingById.set(id, { id: "robinhood-logs" });
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "eth_subscribe",
        params: ["logs", {
          address: active.map((p) => p.address),
          topics: [[...new Set(active.map((p) => p.topic0))]],
        }],
      }));
    });

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.id && msg.result) {
          if (pendingById.has(msg.id)) {
            pendingById.delete(msg.id);
            console.log(JSON.stringify({ subscribed: active.map((p) => p.id), subscription: msg.result }));
          }
          return;
        }
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        const log = msg.params.result;
        const protocol = byLogKey.get(routeKey(log.address, log.topics?.[0]));
        if (!protocol) return;
        if (protocol.id === "pons") state = await handlePonsLog({ state, log, rhCache, hooks });
        if (protocol.id === "long") state = await handleLongLog({ state, log, rhCache, hooks });
        if (protocol.id === "flap") state = await handleFlapLog({ state, log, rhCache, hooks });
        if (protocol.id === "pair") state = await handlePairLog({ state, log, rhCache, hooks });
        await writeState(state);
      } catch (err) {
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
  const url = wsUrlFromEnv();
  const hooks = webhooksFromEnv();
  const rhCache = makeRhCache();
  let attempt = 0;
  for (;;) {
    try {
      await runConnection({ url, rhCache, hooks });
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
