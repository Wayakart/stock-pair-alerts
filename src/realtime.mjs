import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createAlertCap } from "./alert-cap.mjs";
import { createBudgetGuard, isBudgetStopError } from "./budget.mjs";
import { createDryRunDecisionEngine } from "./decision.mjs";
import {
  PONS_FACTORY,
  TOPIC0_APPROVAL,
  LONG_LAUNCHER,
  TOPIC0_LAUNCH,
  FLAP_ROUTER,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  PAIR_COORDINATOR,
  PAIR_POOL_MANAGER,
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
  uniqueWebhookUrls,
  isInterestingAsset,
  normalizeAddr,
  redactUrl,
  hexToBigInt,
  toHex,
} from "./lib.mjs";
import {
  DEFAULT_MOMENTUM_THRESHOLDS,
  TOPIC0_UNISWAP_V4_SWAP,
  aggregateV4Swaps,
  buildV4SwapLogFilter,
  createMomentumCandidate,
  findCandidatePools,
  normalizePoolTrade,
  recordCandidateTrade,
} from "./momentum.mjs";
import { createHeartbeat, createLatencyTrace, logJson, msSince, warnJson } from "./metrics.mjs";
import { createRhPriceCache } from "./rh-price-cache.mjs";
import { appendJsonLine, readJsonFile, writeJsonFile } from "./state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyStatePath = path.join(root, "state", "seen.json");
const statePath = path.join(root, "state", "robinhood.json");
const budgetStatePath = path.resolve(process.env.BUDGET_STATE_PATH || path.join(root, "state", "budget.json"));
const killSwitchPath = path.resolve(process.env.KILL_SWITCH_PATH || path.join(root, "state", "KILL_SWITCH"));
const momentumHistoryPath = path.resolve(process.env.MOMENTUM_HISTORY_PATH || path.join(root, "state", "robinhood-events.ndjson"));
const alertCapStatePath = path.resolve(process.env.ALERT_CAP_STATE_PATH || path.join(root, "state", "alert-cap.json"));
const alertCapHistoryPath = path.resolve(process.env.ALERT_CAP_HISTORY_PATH || path.join(root, "state", "alert-events.ndjson"));
const UA = "stock-pair-alerts/1.6";
const DEFAULT_WS = "wss://rpc-robinhood.blockmachine.io";
const RH_REFRESH_MS = Number(process.env.RH_REFRESH_MS || 300_000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60_000);
const BUDGET_CHECK_MS = Number(process.env.BUDGET_CHECK_MS || 60_000);
const STALE_CONNECTION_MS = Number(process.env.STALE_CONNECTION_MS || 180_000);
const BACKFILL_CHUNK = BigInt(process.env.EVM_BACKFILL_CHUNK || 2_000);
const BACKFILL_OVERLAP_BLOCKS = BigInt(process.env.EVM_BACKFILL_OVERLAP_BLOCKS || 32);
const BOOTSTRAP_LOOKBACK_BLOCKS = BigInt(process.env.EVM_BOOTSTRAP_LOOKBACK_BLOCKS || 100_000);
const MOMENTUM_SUBSCRIPTION_REFRESH_MS = Math.max(1_000, Number(process.env.MOMENTUM_SUBSCRIPTION_REFRESH_MS || 30_000));
const ALERT_CAP_MAX = Number(process.env.ALERT_CAP_MAX || 10);
const ALERT_CAP_WINDOW_MS = Number(process.env.ALERT_CAP_WINDOW_MS || 8 * 60 * 60 * 1_000);
const ERC20_NAME_SELECTOR = "0x06fdde03";
const ERC20_SYMBOL_SELECTOR = "0x95d89b41";
const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const RH_PRICES_URL = "https://api.robinhood.com/rhj/prices/";
const RH_ALL_PRICES_URL = "https://api.robinhood.com/rhj/prices";

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

const momentumProtocol = {
  id: "momentum",
  platform: "Uniswap v4",
  address: PAIR_POOL_MANAGER,
  topic0: TOPIC0_UNISWAP_V4_SWAP,
  checkpoint: "momentumLastBlock",
};

const enabledProtocols = csvSet(process.env.WATCH_PROTOCOLS || "pons,long,flap,pair");
const includeSymbols = csvSet(process.env.INTERESTING_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const excludeSymbols = csvSet(process.env.IGNORE_SYMBOLS, { normalize: (value) => value.toUpperCase() });
const includeAddresses = csvSet(process.env.INTERESTING_ADDRESSES, { normalize: normalizeAddr });
const excludeAddresses = csvSet(process.env.IGNORE_ADDRESSES, { normalize: normalizeAddr });
const interestingOptions = { includeSymbols, excludeSymbols, includeAddresses, excludeAddresses };
const alertCap = createAlertCap({
  statePath: alertCapStatePath,
  historyPath: alertCapHistoryPath,
  maxAlerts: ALERT_CAP_MAX,
  windowMs: ALERT_CAP_WINDOW_MS,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function boolEnv(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(name + " must be a non-negative number");
  return value;
}

function momentumThresholdsFromEnv() {
  return {
    ...DEFAULT_MOMENTUM_THRESHOLDS,
    earlyWindowMs: numberEnv("MOMENTUM_WINDOW_MS", DEFAULT_MOMENTUM_THRESHOLDS.earlyWindowMs),
    trackingWindowMs: numberEnv("MOMENTUM_TRACKING_MS", DEFAULT_MOMENTUM_THRESHOLDS.trackingWindowMs),
    minUniqueBuyers: numberEnv("MOMENTUM_MIN_UNIQUE_BUYERS", DEFAULT_MOMENTUM_THRESHOLDS.minUniqueBuyers),
    minBuyVolumeUsd: numberEnv("MOMENTUM_MIN_BUY_VOLUME_USD", DEFAULT_MOMENTUM_THRESHOLDS.minBuyVolumeUsd),
    minBuyBlocks: numberEnv("MOMENTUM_MIN_BUY_BLOCKS", DEFAULT_MOMENTUM_THRESHOLDS.minBuyBlocks),
    minFollowThroughBuyers: numberEnv("MOMENTUM_MIN_FOLLOW_THROUGH_BUYERS", DEFAULT_MOMENTUM_THRESHOLDS.minFollowThroughBuyers),
    whaleBuyVolumeUsd: numberEnv("MOMENTUM_WHALE_BUY_VOLUME_USD", DEFAULT_MOMENTUM_THRESHOLDS.whaleBuyVolumeUsd),
    minBundleBuyers: numberEnv("MOMENTUM_MIN_BUNDLE_BUYERS", DEFAULT_MOMENTUM_THRESHOLDS.minBundleBuyers),
    walletFallbackBuyers: numberEnv("MOMENTUM_WALLET_FALLBACK_BUYERS", DEFAULT_MOMENTUM_THRESHOLDS.walletFallbackBuyers),
  };
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
  return uniqueWebhookUrls([process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2]);
}

async function reserveTokenAlert(alert) {
  const result = await alertCap.reserve({
    chain: alert.chain,
    platform: alert.platform,
    projectAddress: alert.projectAddress,
    projectSymbol: alert.projectSymbol,
    tx: alert.tx,
  });
  logJson(result.allowed ? "alert_cap_reserved" : "alert_cap_suppressed", {
    chain: alert.chain,
    platform: alert.platform,
    projectAddress: alert.projectAddress,
    projectSymbol: alert.projectSymbol,
    used: result.used,
    remaining: result.remaining,
    maxAlerts: result.maxAlerts,
    windowMs: result.windowMs,
  });
  return result;
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
    const error = new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + res.status + " non-json");
    error.status = res.status;
    throw error;
  }
  if (!res.ok) {
    const error = new Error((opts.method || "GET") + " " + redactUrl(url) + " -> " + res.status);
    error.status = res.status;
    const retryAfter = res.headers.get("retry-after");
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

async function loadSwapTransaction(httpUrl, tx) {
  let lastError = new Error("Swap transaction details are not available yet");
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const [transaction, receipt] = await evmRpcBatch(httpUrl, [
        { method: "eth_getTransactionByHash", params: [tx] },
        { method: "eth_getTransactionReceipt", params: [tx] },
      ]);
      const buyer = transaction?.from || receipt?.from;
      if (receipt && buyer) return { buyer, receipt };
      lastError = new Error("Swap transaction details are not available yet");
    } catch (err) {
      lastError = err;
    }
    if (attempt < 5) await sleep(Math.min(2_000, 100 * 2 ** (attempt - 1)));
  }
  throw lastError;
}

function discordEndpoint(raw, { wait = false, messageId = "" } = {}) {
  const url = new URL(raw);
  if (messageId) url.pathname = url.pathname.replace(/\/$/, "") + "/messages/" + encodeURIComponent(messageId);
  if (wait) url.searchParams.set("wait", "true");
  return url.toString();
}

async function discordRequest(url, payload, { method = "POST", wait = false } = {}) {
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", "user-agent": UA },
      body,
    });
    const responseBody = await res.text();
    if ([200, 204].includes(res.status)) {
      if (!wait || !responseBody) return null;
      try { return JSON.parse(responseBody); } catch { return null; }
    }
    if (res.status === 429 && attempt < 5) {
      let retryAfter = 1;
      try { retryAfter = Number(JSON.parse(responseBody).retry_after) || 1; } catch {}
      await sleep(Math.min(Math.max(retryAfter, 0.3), 8) * 1000 + 150);
      continue;
    }
    throw new Error("Discord " + res.status + " " + responseBody.slice(0, 120));
  }
  return null;
}

async function notify(webhooks, payload, { wait = false } = {}) {
  const messages = [];
  for (let index = 0; index < webhooks.length; index++) {
    const message = await discordRequest(discordEndpoint(webhooks[index], { wait }), payload, { wait });
    if (message?.id) messages.push({ webhookIndex: index, messageId: message.id });
  }
  return messages;
}

async function updateNotifications(webhooks, messageIds, payload) {
  for (const message of messageIds || []) {
    const webhook = webhooks[message.webhookIndex];
    if (!webhook || !message.messageId) continue;
    await discordRequest(discordEndpoint(webhook, { messageId: message.messageId }), payload, {
      method: "PATCH",
      wait: true,
    });
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
    async get(address, { force = false } = {}) {
      const key = normalizeAddr(address);
      if (!force && values.has(key)) return values.get(key);
      let metadata = {};
      try {
        const [nameResult, symbolResult, supplyResult, decimalsResult] = await evmRpcBatch(httpUrl, [
          { method: "eth_call", params: [{ to: key, data: ERC20_NAME_SELECTOR }, "latest"] },
          { method: "eth_call", params: [{ to: key, data: ERC20_SYMBOL_SELECTOR }, "latest"] },
          { method: "eth_call", params: [{ to: key, data: ERC20_TOTAL_SUPPLY_SELECTOR }, "latest"] },
          { method: "eth_call", params: [{ to: key, data: ERC20_DECIMALS_SELECTOR }, "latest"] },
        ]);
        metadata = {
          name: decodeAbiString(nameResult),
          symbol: decodeAbiString(symbolResult),
          totalSupply: decodeRpcUint(supplyResult, 0n).toString(),
          decimals: Number(decodeRpcUint(decimalsResult, 18n)),
        };
      } catch (err) {
        console.warn("token metadata lookup failed:", key, err.message);
      }
      if (metadata.symbol || metadata.name || metadata.totalSupply !== "0") values.set(key, metadata);
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

async function momentumHistory(type, details) {
  await appendJsonLine(momentumHistoryPath, {
    type,
    recordedAt: new Date().toISOString(),
    ...details,
  });
}

async function blockTimestampMs(httpUrl, blockNumber, blockTimestamp, observedAtMs) {
  if (blockTimestamp) return Number(BigInt(blockTimestamp)) * 1_000;
  if (observedAtMs) return observedAtMs;
  const block = await evmRpc(httpUrl, "eth_getBlockByNumber", [toHex(blockNumber), false]);
  return block?.timestamp ? Number(BigInt(block.timestamp)) * 1_000 : Date.now();
}

function momentumAlert(candidate, metrics, reasons, tx) {
  return {
    chain: "robinhood",
    platform: candidate.platform,
    verb: candidate.discordMessageIds?.length ? "momentum update" : "momentum",
    projectAddress: candidate.project.address,
    projectSymbol: candidate.project.symbol,
    projectName: candidate.project.name,
    quotes: [candidate.quote],
    tx,
    signal: {
      ...metrics,
      reasons,
      quoteSymbol: candidate.quote.symbol,
      milestones: candidate.milestones,
    },
  };
}

function pruneMomentumCandidates(state, nowMs, trackingWindowMs) {
  const candidates = { ...(state.momentumCandidates || {}) };
  for (const [poolId, candidate] of Object.entries(candidates)) {
    if (nowMs - Number(candidate.launchedAtMs || 0) > trackingWindowMs) delete candidates[poolId];
  }
  return candidates;
}

async function registerMomentumCandidates(context, { platform, projectAddress, quotes, tx, block, blockTimestamp, receipt: knownReceipt }) {
  const { state, httpUrl, tokenCache, momentumThresholds } = context;
  const launchedAtMs = await blockTimestampMs(httpUrl, block, blockTimestamp, context.observedAtMs);
  const receipt = knownReceipt || await evmRpc(httpUrl, "eth_getTransactionReceipt", [tx]);
  if (!receipt) throw new Error(platform + " launch receipt is not available yet");
  const projectMeta = await tokenCache.get(projectAddress);
  const project = {
    address: normalizeAddr(projectAddress),
    name: projectMeta.name || "",
    symbol: projectMeta.symbol || "",
    totalSupply: projectMeta.totalSupply || "0",
    decimals: Number.isInteger(projectMeta.decimals) ? projectMeta.decimals : 18,
  };
  const pools = findCandidatePools(receipt, project.address, quotes.map((quote) => quote.address));
  let candidates = pruneMomentumCandidates(state, launchedAtMs, momentumThresholds.trackingWindowMs);
  await momentumHistory("candidate_seen", {
    platform,
    project,
    quotes,
    launchTx: tx,
    launchBlock: block,
    pools: pools.map((pool) => pool.poolId),
  });
  for (const pool of pools) {
    if (candidates[pool.poolId]) continue;
    const quote = quotes.find((item) => [pool.currency0, pool.currency1].includes(normalizeAddr(item.address)));
    if (!quote) continue;
    const candidate = createMomentumCandidate({
      pool,
      platform,
      project,
      quote: {
        ...quote,
        decimals: Number.isInteger(quote.decimals) ? quote.decimals : 18,
      },
      launchTx: tx,
      launchBlock: block,
      launchedAtMs,
    });
    if (!candidate) continue;
    candidates = { ...candidates, [pool.poolId]: candidate };
    logJson("momentum_candidate", {
      platform,
      poolId: pool.poolId,
      project: project.address,
      quote: quote.address,
      launchBlock: block,
    });
  }
  if (!pools.length) {
    warnJson("momentum_pool_missing", { platform, project: project.address, launchTx: tx });
  }
  return {
    ...state,
    momentumCandidates: candidates,
    momentumLastBlock: Math.max(Number(state.momentumLastBlock || 0), Number(block || 0)),
  };
}

async function handleMomentumLog(context) {
  const { state, log, httpUrl, rhPriceCache, tokenCache, hooks, decisionEngine, heartbeat, momentumThresholds } = context;
  const poolId = String(log.topics?.[1] || "").toLowerCase();
  const block = Number(hexToBigInt(log.blockNumber));
  let candidates = { ...(state.momentumCandidates || {}) };
  let candidate = candidates[poolId];
  if (!candidate || (candidate.processedTxs || []).includes(log.transactionHash)) return state;
  if (candidate.project.totalSupply === "0") {
    const metadata = await tokenCache.get(candidate.project.address, { force: true });
    candidate = {
      ...candidate,
      project: {
        ...candidate.project,
        name: metadata.name || candidate.project.name,
        symbol: metadata.symbol || candidate.project.symbol,
        totalSupply: metadata.totalSupply || candidate.project.totalSupply,
        decimals: Number.isInteger(metadata.decimals) ? metadata.decimals : candidate.project.decimals,
      },
    };
    candidates[poolId] = candidate;
  }

  const { buyer, receipt } = await loadSwapTransaction(httpUrl, log.transactionHash);
  const aggregate = aggregateV4Swaps(receipt.logs, poolId);
  if (!aggregate) return state;
  if (aggregate.tx === candidate.launchTx) {
    candidate = { ...candidate, processedTxs: [...(candidate.processedTxs || []), aggregate.tx].slice(-500) };
    candidates[poolId] = candidate;
    return { ...state, momentumCandidates: candidates, momentumLastBlock: Math.max(Number(state.momentumLastBlock || 0), block) };
  }

  const timestampMs = await blockTimestampMs(httpUrl, block, log.blockTimestamp, context.observedAtMs);
  if (timestampMs - candidate.launchedAtMs > momentumThresholds.trackingWindowMs) {
    delete candidates[poolId];
    await momentumHistory("candidate_expired", { poolId, project: candidate.project.address, block });
    return { ...state, momentumCandidates: candidates, momentumLastBlock: Math.max(Number(state.momentumLastBlock || 0), block) };
  }

  const quoteUsd = await rhPriceCache.get(candidate.quote);
  const trade = normalizePoolTrade(candidate, aggregate, {
    buyer,
    timestampMs,
    quoteUsd,
  });
  const result = recordCandidateTrade(candidate, trade, momentumThresholds);
  candidate = result.candidate;
  candidates[poolId] = candidate;
  const tradeHistoryWrite = momentumHistory("trade", {
    poolId,
    platform: candidate.platform,
    project: candidate.project.address,
    quote: candidate.quote.address,
    trade,
    metrics: result.metrics,
  });

  if (result.shouldNotify) {
    let discordAction = "not_attempted";
    const existingMessage = Object.values(candidates).find((item) =>
      item.poolId !== candidate.poolId &&
      item.project.address === candidate.project.address &&
      item.discordMessageIds?.length
    );
    if (existingMessage) candidate.discordMessageIds = existingMessage.discordMessageIds;
    const alert = momentumAlert(candidate, result.metrics, result.reasons, trade.tx);
    if (existingMessage) {
      try {
        await updateNotifications(hooks, candidate.discordMessageIds, buildDiscordAlertPayload(alert));
        context.trace?.mark("alert_updated");
        discordAction = "updated_existing_token";
      } catch (err) {
        console.warn("momentum cross-pool update failed:", err.message);
        discordAction = "update_failed";
      }
    } else {
      console.log(JSON.stringify({ alert }));
      if (!hooks.length) {
        console.warn("qualified momentum alert ready but DISCORD_WEBHOOK_URL is not set");
        discordAction = "webhook_not_configured";
      } else {
        const reservation = await reserveTokenAlert(alert);
        if (!reservation.allowed) {
          discordAction = "suppressed_alert_cap";
          context.trace?.mark("alert_suppressed");
        } else {
          await decisionEngine.evaluate(alert, {
            receivedToDecisionMs: context.trace?.elapsedMs(),
            reason: result.reasons.join(", "),
          });
          try {
            candidate.discordMessageIds = await notify(hooks, buildDiscordAlertPayload(alert, {
              rickAutoScan: context.rickAutoScan,
            }), { wait: true });
            heartbeat?.alert();
            context.trace?.mark("alert_sent");
            discordAction = "created";
          } catch (err) {
            console.warn("momentum notify failed:", err.message);
            discordAction = "notify_failed";
          }
        }
      }
    }
    candidates[poolId] = candidate;
    await momentumHistory("qualified", {
      poolId,
      project: candidate.project.address,
      reasons: result.reasons,
      metrics: result.metrics,
      tx: trade.tx,
      discordAction,
    });
  } else if (result.shouldUpdate) {
    const reasons = result.newMilestones.map((level) => "$" + (level / 1_000) + "k estimated FDV");
    const alert = momentumAlert(candidate, result.metrics, reasons, trade.tx);
    try {
      await updateNotifications(hooks, candidate.discordMessageIds, buildDiscordAlertPayload(alert));
      context.trace?.mark("alert_updated");
    } catch (err) {
      console.warn("momentum update failed:", err.message);
    }
    await momentumHistory("milestone", {
      poolId,
      project: candidate.project.address,
      milestones: result.newMilestones,
      metrics: result.metrics,
      tx: trade.tx,
    });
  }

  await tradeHistoryWrite;

  return {
    ...state,
    momentumCandidates: candidates,
    momentumLastBlock: Math.max(Number(state.momentumLastBlock || 0), block),
  };
}

async function sendAlert({ hooks, alert, decisionEngine, trace, heartbeat, rickAutoScan }) {
  console.log(JSON.stringify({ alert }));
  if (!hooks.length) {
    await decisionEngine.evaluate(alert, { receivedToDecisionMs: trace.elapsedMs() });
    console.warn("alert ready but DISCORD_WEBHOOK_URL is not set");
    return;
  }
  const reservation = await reserveTokenAlert(alert);
  if (!reservation.allowed) {
    trace.mark("alert_suppressed");
    return;
  }
  await decisionEngine.evaluate(alert, { receivedToDecisionMs: trace.elapsedMs() });
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
  await momentumHistory("catalog_event", {
    platform: "Pons",
    project: event.pairToken,
    symbol: meta.symbol || "",
    tx: event.tx,
    block: event.block,
  });
  if (!boolEnv("PONS_APPROVAL_ALERTS")) return next;
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
  return registerMomentumCandidates({ ...context, state: next }, {
    platform: "Long",
    projectAddress: event.asset,
    quotes: [{ ...quote, address: event.numeraire }],
    tx: event.tx,
    block: event.block,
    blockTimestamp: log.blockTimestamp,
  });
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
  return registerMomentumCandidates({ ...context, state: next }, {
    platform: "Flap",
    projectAddress: event.token,
    quotes: [{ ...quote, address: event.quote }],
    tx: event.tx,
    block: event.block,
    blockTimestamp: log.blockTimestamp,
  });
}

async function pairPoolsFromReceipt(httpUrl, event) {
  const receipt = await evmRpc(httpUrl, "eth_getTransactionReceipt", [event.tx]);
  if (!receipt) throw new Error("Pair launch receipt is not available yet");
  const pools = (receipt.logs || [])
    .filter((log) => normalizeAddr(log.address) === normalizeAddr(PAIR_COORDINATOR))
    .map(decodePairCanonicalPoolLog)
    .filter((pool) => pool && pool.project === event.project);
  return { receipt, pools };
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
  const { receipt, pools } = await pairPoolsFromReceipt(httpUrl, event);
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

  return registerMomentumCandidates({ ...context, state: next }, {
    platform: "Pair",
    projectAddress: event.project,
    quotes,
    tx: event.tx,
    block: event.block,
    blockTimestamp: log.blockTimestamp,
    receipt,
  });
}

async function processLog(context) {
  if (context.protocol.id === "momentum") return handleMomentumLog(context);
  if (context.protocol.id === "pons") return handlePonsLog(context);
  if (context.protocol.id === "long") return handleLongLog(context);
  if (context.protocol.id === "flap") return handleFlapLog(context);
  if (context.protocol.id === "pair") return handlePairLog(context);
  return context.state;
}

async function getLogsRange(httpUrl, protocol, fromBlock, toBlock, filter = {}) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += BACKFILL_CHUNK) {
    const end = start + BACKFILL_CHUNK - 1n > toBlock ? toBlock : start + BACKFILL_CHUNK - 1n;
    const page = await evmRpc(httpUrl, "eth_getLogs", [{
      address: filter.address || protocol.address,
      fromBlock: toHex(start),
      toBlock: toHex(end),
      topics: filter.topics || [protocol.topic0],
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
  context.state = await runMomentumBackfill(context, latest);
  context.state.initialized = true;
  await writeState(context.state);
  return context.state;
}

async function runMomentumBackfill(context, latest, { fromBlock: requestedFromBlock } = {}) {
  const nowMs = Date.now();
  context.state.momentumCandidates = pruneMomentumCandidates(
    context.state,
    nowMs,
    context.momentumThresholds.trackingWindowMs
  );
  const candidates = Object.values(context.state.momentumCandidates || {});
  if (!candidates.length) {
    context.state.momentumLastBlock = Number(latest);
    return context.state;
  }
  const checkpoint = BigInt(context.state.momentumLastBlock || 0);
  const oldestLaunch = BigInt(Math.min(...candidates.map((candidate) => Number(candidate.launchBlock || latest))));
  const checkpointFromBlock = checkpoint === 0n
    ? oldestLaunch
    : (checkpoint >= BACKFILL_OVERLAP_BLOCKS ? checkpoint - BACKFILL_OVERLAP_BLOCKS + 1n : 0n);
  const fromBlock = requestedFromBlock === undefined ? checkpointFromBlock : BigInt(requestedFromBlock);
  const filter = buildV4SwapLogFilter(candidates.map((candidate) => candidate.poolId));
  const logs = await getLogsRange(context.httpUrl, momentumProtocol, fromBlock, latest, filter);
  for (const log of logs) {
    const poolId = String(log.topics?.[1] || "").toLowerCase();
    if (!context.state.momentumCandidates?.[poolId]) continue;
    const trace = createLatencyTrace({
      chain: "robinhood",
      platform: context.state.momentumCandidates[poolId].platform,
      tx: log.transactionHash,
      block: Number(hexToBigInt(log.blockNumber)),
      source: "backfill",
    });
    context.state = await processLog({
      ...context,
      state: context.state,
      protocol: momentumProtocol,
      log,
      trace,
      allowAlerts: true,
    });
    trace.done("momentum_backfill_handled");
  }
  context.state.momentumLastBlock = Math.max(Number(context.state.momentumLastBlock || 0), Number(latest));
  logJson("momentum_backfill", {
    fromBlock: Number(fromBlock),
    toBlock: Number(latest),
    logs: logs.length,
    candidates: Object.keys(context.state.momentumCandidates || {}).length,
  });
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
    service: "robinhood",
    message: "Configured provider spend crossed " + Math.round(budget.crossedThreshold * 100) + "% of the weekly cap.",
    fields: [
      { name: "Estimated spend", value: "$" + Number(budget.estimatedUsd || 0).toFixed(2), inline: true },
      { name: "Budget", value: "$" + Number(budget.weeklyBudgetUsd || 0).toFixed(2), inline: true },
    ],
  });
  return budget;
}

async function runConnection({
  url,
  httpUrl,
  rhCache,
  rhPriceCache,
  tokenCache,
  hooks,
  checkBudget,
  heartbeat,
  decisionEngine,
  rickAutoScan,
  momentumThresholds,
}) {
  let state = await readState();
  let nextId = 1;
  let processing = Promise.resolve();
  const byLogKey = new Map();
  const active = protocols.filter((protocol) => enabledProtocols.has(protocol.id));
  if (!active.length) throw new Error("No protocols enabled. Set WATCH_PROTOCOLS=pons,long,flap,pair or add a protocol id.");
  for (const protocol of active) byLogKey.set(routeKey(protocol.address, protocol.topic0), protocol);

  await checkBudgetAndWarn(() => checkBudget({ force: true }), hooks);
  const rhMap = await rhCache.get();
  void rhPriceCache.prime(Object.values(rhMap));
  await writeState(state);
  logJson("listener_start", {
    mode: "realtime",
    url: redactUrl(url),
    httpUrl: redactUrl(httpUrl),
    protocols: active.map((protocol) => protocol.id),
    momentumThresholds,
    hasWebhook: hooks.length > 0,
    rickAutoScan,
    statePath,
  });

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    let settled = false;
    let launchSubscriptionId = "";
    let momentumSubscription = null;
    let pendingMomentumSubscription = null;
    let backfillStarted = false;
    let momentumCaughtUp = false;
    let budgetCheckRunning = false;
    const requests = new Map();
    const subscriptions = new Map();
    const heartbeatTimer = setInterval(() => {
      void heartbeat.tick({ force: true }).catch((err) => console.warn("heartbeat failed:", err.message));
    }, HEARTBEAT_MS).unref();
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 60_000).unref();
    const budgetTimer = setInterval(() => {
      if (budgetCheckRunning) return;
      budgetCheckRunning = true;
      void checkBudgetAndWarn(checkBudget, hooks)
        .catch((err) => {
          heartbeat.error();
          console.warn("budget check failed:", err.message);
          finish(err);
        })
        .finally(() => {
          budgetCheckRunning = false;
        });
    }, BUDGET_CHECK_MS).unref();
    const priceTimer = setInterval(() => {
      void rhCache.get()
        .then((assets) => rhPriceCache.prime(Object.values(assets), { force: true }))
        .catch((err) => console.warn("price refresh failed:", err.message));
    }, RH_REFRESH_MS).unref();
    const momentumTimer = setInterval(() => {
      if (settled) return;
      enqueue(async () => {
        const before = Object.keys(state.momentumCandidates || {}).sort();
        const candidates = pruneMomentumCandidates(state, Date.now(), momentumThresholds.trackingWindowMs);
        const after = Object.keys(candidates).sort();
        if (samePoolIds(before, after)) return;
        state = { ...state, momentumCandidates: candidates };
        await writeState(state);
        logJson("momentum_candidates_pruned", { removed: before.length - after.length, remaining: after.length });
        reconcileMomentumSubscription();
      });
    }, MOMENTUM_SUBSCRIPTION_REFRESH_MS).unref();

    function finish(err) {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      clearInterval(pingTimer);
      clearInterval(budgetTimer);
      clearInterval(priceTimer);
      clearInterval(momentumTimer);
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

    function samePoolIds(left, right) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function sendRequest(method, params, request) {
      if (ws.readyState !== WebSocket.OPEN) return null;
      const id = nextId++;
      requests.set(id, request);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      return id;
    }

    function unsubscribe(subscription, reason) {
      if (!subscription?.id) return;
      subscriptions.delete(subscription.id);
      sendRequest("eth_unsubscribe", [subscription.id], {
        kind: "unsubscribe",
        subscriptionId: subscription.id,
      });
      logJson("unsubscribed", { kind: subscription.kind, pools: subscription.poolIds?.length || 0, reason });
    }

    function desiredMomentumPoolIds() {
      return Object.keys(state.momentumCandidates || {}).map((poolId) => poolId.toLowerCase()).sort();
    }

    function reconcileMomentumSubscription() {
      if (settled || ws.readyState !== WebSocket.OPEN || !backfillStarted) return;
      const poolIds = desiredMomentumPoolIds();
      if (pendingMomentumSubscription) return;
      if (momentumSubscription && samePoolIds(momentumSubscription.poolIds, poolIds)) return;
      if (!poolIds.length) {
        if (momentumSubscription) unsubscribe(momentumSubscription, "no_active_candidates");
        momentumSubscription = null;
        return;
      }
      const filter = buildV4SwapLogFilter(poolIds);
      const subscribedPoolIds = new Set(momentumSubscription?.poolIds || []);
      const addedCandidates = poolIds
        .filter((poolId) => !subscribedPoolIds.has(poolId))
        .map((poolId) => state.momentumCandidates?.[poolId])
        .filter(Boolean);
      const checkpointFromBlock = Math.max(
        0,
        Number(state.momentumLastBlock || 0) - Number(BACKFILL_OVERLAP_BLOCKS) + 1
      );
      const backfillFromBlock = !momentumSubscription && momentumCaughtUp
        ? checkpointFromBlock
        : addedCandidates.length
          ? Math.min(...addedCandidates.map((candidate) => Number(candidate.launchBlock || 0)))
          : null;
      const requestId = sendRequest("eth_subscribe", ["logs", filter], {
        kind: "momentum_subscribe",
        poolIds,
        backfillFromBlock,
      });
      if (requestId) {
        pendingMomentumSubscription = { requestId, poolIds };
        logJson("momentum_subscription_requested", { pools: poolIds.length });
      }
    }

    function processingContext(extra = {}) {
      return {
        state,
        active,
        httpUrl,
        rhCache,
        rhPriceCache,
        tokenCache,
        hooks,
        heartbeat,
        decisionEngine,
        rickAutoScan,
        momentumThresholds,
        ...extra,
      };
    }

    function responseError(request, error) {
      if (request.kind === "momentum_subscribe") pendingMomentumSubscription = null;
      if (request.kind === "unsubscribe") {
        warnJson("unsubscribe_failed", { subscription: request.subscriptionId, error });
        return;
      }
      finish(new Error(request.kind + " " + JSON.stringify(error)));
    }

    function handleResponse(msg) {
      const request = requests.get(msg.id);
      if (!request) return false;
      requests.delete(msg.id);
      if (msg.error) {
        responseError(request, msg.error);
        return true;
      }
      if (request.kind === "unsubscribe") return true;
      const subscriptionId = String(msg.result || "");
      if (!subscriptionId) {
        responseError(request, { message: "missing subscription id" });
        return true;
      }
      if (request.kind === "launch_subscribe") {
        launchSubscriptionId = subscriptionId;
        subscriptions.set(subscriptionId, { id: subscriptionId, kind: "launch" });
        logJson("subscribed", {
          kind: "launch",
          protocols: active.map((protocol) => protocol.id),
          subscription: subscriptionId,
        });
        if (!backfillStarted) {
          backfillStarted = true;
          enqueue(async () => {
            state = await runBackfill(processingContext());
            momentumCaughtUp = true;
            reconcileMomentumSubscription();
          });
        }
        return true;
      }
      if (request.kind === "momentum_subscribe") {
        const previous = momentumSubscription;
        pendingMomentumSubscription = null;
        momentumSubscription = {
          id: subscriptionId,
          kind: "momentum",
          poolIds: request.poolIds,
        };
        subscriptions.set(subscriptionId, momentumSubscription);
        if (previous?.id !== subscriptionId) unsubscribe(previous, "replaced");
        logJson("subscribed", {
          kind: "momentum",
          pools: request.poolIds.length,
          subscription: subscriptionId,
        });
        if (request.backfillFromBlock !== null) {
          enqueue(async () => {
            const latest = hexToBigInt(await evmRpc(httpUrl, "eth_blockNumber", []));
            state = await runMomentumBackfill(processingContext(), latest, {
              fromBlock: request.backfillFromBlock,
            });
            await writeState(state);
            reconcileMomentumSubscription();
          });
        }
        reconcileMomentumSubscription();
        return true;
      }
      return false;
    }

    ws.on("open", () => {
      void heartbeat.tick({ force: true }).catch((err) => console.warn("heartbeat failed:", err.message));
      sendRequest("eth_subscribe", ["logs", {
        address: [...new Set(active.map((protocol) => protocol.address))],
        topics: [[...new Set(active.map((protocol) => protocol.topic0))]],
      }], { kind: "launch_subscribe" });
    });

    ws.on("message", (data) => {
      heartbeat.message();
      const receivedNs = process.hrtime.bigint();
      const observedAtMs = Date.now();
      try {
        const msg = JSON.parse(String(data));
        if (msg.id !== undefined && handleResponse(msg)) return;
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        const log = msg.params?.result;
        const subscription = subscriptions.get(msg.params?.subscription);
        if (!log || !subscription) return;
        let protocol;
        if (subscription.kind === "launch") {
          if (msg.params.subscription !== launchSubscriptionId) return;
          protocol = byLogKey.get(routeKey(log.address, log.topics?.[0]));
        } else {
          const poolId = String(log.topics?.[1] || "").toLowerCase();
          if (!subscription.poolIds.includes(poolId)) return;
          protocol = momentumProtocol;
        }
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
            const nextState = await processLog({
              state,
              protocol,
              log,
              httpUrl,
              rhCache,
              rhPriceCache,
              tokenCache,
              hooks,
              heartbeat,
              decisionEngine,
              trace,
              rickAutoScan,
              momentumThresholds,
              observedAtMs,
              allowAlerts: true,
            });
            if (nextState !== state) {
              state = nextState;
              await writeState(state);
            }
            reconcileMomentumSubscription();
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
  const rhPriceCache = createRhPriceCache({
    requestJson: httpJson,
    pricesUrl: RH_PRICES_URL,
    allPricesUrl: RH_ALL_PRICES_URL,
    warn: warnJson,
  });
  const tokenCache = makeTokenMetadataCache(httpUrl);
  const budgetGuard = await createBudgetGuard({ statePath: budgetStatePath, killSwitchPath });
  const checkBudget = makeBudgetChecker(budgetGuard);
  const rickAutoScan = boolEnv("RICK_AUTOSCAN");
  const momentumThresholds = momentumThresholdsFromEnv();
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
      await runConnection({
        url,
        httpUrl,
        rhCache,
        rhPriceCache,
        tokenCache,
        hooks,
        checkBudget,
        heartbeat,
        decisionEngine,
        rickAutoScan,
        momentumThresholds,
      });
      attempt += 1;
    } catch (err) {
      if (isBudgetStopError(err)) {
        console.error("robinhood realtime listener stopped:", err.message);
        process.exit(2);
      }
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
  process.exit(isBudgetStopError(err) ? 2 : 1);
});
