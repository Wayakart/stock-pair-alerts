import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RPC,
  FLAP_ROUTER,
  LONG_LAUNCHER,
  PAIR_COORDINATOR,
  RH_ASSETS_URL,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  TOPIC0_LAUNCH,
  TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED,
  decodeAbiString,
  decodeFlapQuoteSetLog,
  decodeLaunchLog,
  decodePairCanonicalPoolLog,
  decodePairCanonicalProjectLog,
  extractRhAssets,
  normalizeAddr,
  redactUrl,
  toHex,
} from "./lib.mjs";
import {
  TOPIC0_UNISWAP_V4_SWAP,
  UNISWAP_V4_POOL_MANAGER,
  aggregateV4Swaps,
  createMomentumCandidate,
  findCandidatePools,
  normalizePoolTrade,
  recordCandidateTrade,
} from "./momentum.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ERC20_NAME_SELECTOR = "0x06fdde03";
const ERC20_SYMBOL_SELECTOR = "0x95d89b41";
const ERC20_TOTAL_SUPPLY_SELECTOR = "0x18160ddd";
const ERC20_DECIMALS_SELECTOR = "0x313ce567";
const LOG_CHUNK = 2_000n;
const REPLAY_MS = Number(process.env.REPLAY_WINDOW_MS || 300_000);
const BLOCKS_PER_REPLAY = BigInt(process.env.REPLAY_MAX_BLOCKS || 3_200);
const RPC_MIN_INTERVAL_MS = Number(process.env.REPLAY_RPC_MIN_INTERVAL_MS || 100);
const UA = "stock-pair-alerts-replay/1.0";
let rpcQueue = Promise.resolve();
let lastRpcStartedAt = 0;

const protocols = [
  { id: "long", address: LONG_LAUNCHER, topic0: TOPIC0_LAUNCH, decode: decodeLaunchLog },
  { id: "flap", address: FLAP_ROUTER, topic0: TOPIC0_FLAP_TOKEN_QUOTE_SET, decode: decodeFlapQuoteSetLog },
  { id: "pair", address: PAIR_COORDINATOR, topic0: TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED, decode: decodePairCanonicalProjectLog },
];

function rpcUrlFromEnv() {
  const explicit = String(process.env.EVM_REPLAY_RPC_HTTP_URL || process.env.REALTIME_RPC_HTTP_URL || "").trim();
  if (explicit) return explicit;
  const ws = String(process.env.REALTIME_RPC_WS_URL || "").trim();
  if (!ws) return DEFAULT_RPC;
  const url = new URL(ws);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { accept: "application/json", "user-agent": UA, ...(options.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error((options.method || "GET") + " " + redactUrl(url) + " -> " + response.status);
  return text ? JSON.parse(text) : null;
}

function scheduledRpcRequest(url, options) {
  const request = rpcQueue.then(async () => {
    const waitMs = Math.max(0, lastRpcStartedAt + RPC_MIN_INTERVAL_MS - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastRpcStartedAt = Date.now();
    return jsonRequest(url, options);
  });
  rpcQueue = request.catch(() => {});
  return request;
}

async function rpc(url, method, params) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const body = await scheduledRpcRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (body?.error) throw new Error(method + " " + JSON.stringify(body.error));
      return body?.result;
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }
}

async function rpcBatch(url, calls) {
  const request = calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, ...call }));
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const body = await scheduledRpcRequest(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const byId = new Map((body || []).map((item) => [item.id, item]));
      return request.map((item) => {
        const response = byId.get(item.id);
        return response && !response.error ? response.result : null;
      });
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getLogs(url, address, topic0, fromBlock, toBlock, topic1) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n > toBlock ? toBlock : start + LOG_CHUNK - 1n;
    const topics = topic1 ? [topic0, topic1] : [topic0];
    const page = await rpc(url, "eth_getLogs", [{ address, fromBlock: toHex(start), toBlock: toHex(end), topics }]);
    logs.push(...(page || []));
  }
  return logs;
}

function blockNumber(block) {
  return Number(BigInt(block?.number || 0));
}

function blockTimeMs(block) {
  return Number(BigInt(block?.timestamp || 0)) * 1_000;
}

async function findBlockAtOrAfter(url, targetMs, latest) {
  let low = 0n;
  let high = latest;
  while (low < high) {
    const middle = (low + high) / 2n;
    const block = await rpc(url, "eth_getBlockByNumber", [toHex(middle), false]);
    if (blockTimeMs(block) < targetMs) low = middle + 1n;
    else high = middle;
  }
  return low;
}

function uintResult(value, fallback) {
  try { return value && value !== "0x" ? BigInt(value) : fallback; } catch { return fallback; }
}

async function tokenMetadata(url, address) {
  const [name, symbol, supply, decimals] = await rpcBatch(url, [
    { method: "eth_call", params: [{ to: address, data: ERC20_NAME_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: ERC20_SYMBOL_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: ERC20_TOTAL_SUPPLY_SELECTOR }, "latest"] },
    { method: "eth_call", params: [{ to: address, data: ERC20_DECIMALS_SELECTOR }, "latest"] },
  ]);
  return {
    address: normalizeAddr(address),
    name: decodeAbiString(name),
    symbol: decodeAbiString(symbol),
    totalSupply: uintResult(supply, 0n).toString(),
    decimals: Number(uintResult(decimals, 18n)),
  };
}

async function loadPrices(rhMap) {
  try {
    const payload = await jsonRequest("https://api.robinhood.com/rhj/prices");
    const prices = {};
    for (const quote of payload?.quotes || []) {
      const symbol = String(quote.tokenSymbol || "").toUpperCase();
      const asset = Object.values(rhMap).find((item) => item.symbol === symbol);
      if (!asset) continue;
      const bid = Number(quote.bid);
      const ask = Number(quote.ask);
      const raw = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
      if (Number.isFinite(raw) && raw > 0) prices[asset.address] = raw * asset.currentMultiplier;
    }
    return { source: "robinhood", prices };
  } catch (err) {
    return { source: "unavailable", error: err.message, prices: {} };
  }
}

async function main() {
  const startIso = process.argv[2];
  const endIso = process.argv[3];
  if (!startIso || !endIso) throw new Error("Usage: npm run replay:robinhood -- <start-iso> <end-iso> [output.json]");
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Invalid replay window");
  const outputPath = path.resolve(process.argv[4] || path.join(root, "reports", "robinhood-signal-replay.json"));
  const url = rpcUrlFromEnv();
  const latest = BigInt(await rpc(url, "eth_blockNumber", []));
  const fromBlock = await findBlockAtOrAfter(url, startMs, latest);
  const toBlock = await findBlockAtOrAfter(url, endMs, latest);
  const rhMap = extractRhAssets(await jsonRequest(RH_ASSETS_URL));
  const pricing = await loadPrices(rhMap);
  const receiptCache = new Map();
  const blockCache = new Map();

  async function receipt(tx) {
    if (!receiptCache.has(tx)) receiptCache.set(tx, rpc(url, "eth_getTransactionReceipt", [tx]));
    return receiptCache.get(tx);
  }

  async function timestampMs(number, timestamp) {
    if (timestamp) return Number(BigInt(timestamp)) * 1_000;
    if (!blockCache.has(number)) blockCache.set(number, rpc(url, "eth_getBlockByNumber", [toHex(number), false]));
    return blockTimeMs(await blockCache.get(number));
  }

  const protocolLogs = (await mapLimit(protocols, 3, async (protocol) => {
    const logs = await getLogs(url, protocol.address, protocol.topic0, fromBlock, toBlock);
    return logs.map((log) => ({ protocol, log, event: protocol.decode(log) })).filter((item) => item.event);
  })).flat().sort((a, b) => blockNumber(a.log) - blockNumber(b.log));

  const boundedProtocolLogs = (await mapLimit(protocolLogs, 8, async (item) => ({
    ...item,
    eventTimestampMs: await timestampMs(blockNumber(item.log), item.log.blockTimestamp),
  }))).filter(({ eventTimestampMs }) => eventTimestampMs >= startMs && eventTimestampMs <= endMs);

  const launches = await mapLimit(boundedProtocolLogs, 8, async ({ protocol, log, event, eventTimestampMs }) => {
    let projectAddress;
    let quotes = [];
    const launchReceipt = await receipt(event.tx);
    if (protocol.id === "long") {
      projectAddress = event.asset;
      if (rhMap[event.numeraire]) quotes = [rhMap[event.numeraire]];
    } else if (protocol.id === "flap") {
      projectAddress = event.token;
      if (rhMap[event.quote]) quotes = [rhMap[event.quote]];
    } else {
      projectAddress = event.project;
      const seen = new Set();
      quotes = (launchReceipt?.logs || [])
        .filter((item) => normalizeAddr(item.address) === normalizeAddr(PAIR_COORDINATOR))
        .map(decodePairCanonicalPoolLog)
        .filter((pool) => pool?.project === event.project && rhMap[pool.quote] && !seen.has(pool.quote) && seen.add(pool.quote))
        .map((pool) => rhMap[pool.quote]);
    }
    if (!projectAddress || !quotes.length || !launchReceipt) return null;
    const project = await tokenMetadata(url, projectAddress);
    const pools = findCandidatePools(launchReceipt, projectAddress, quotes.map((quote) => quote.address));
    return {
      protocol: protocol.id,
      project,
      quotes,
      launchTx: event.tx,
      launchBlock: Number(BigInt(log.blockNumber)),
      launchedAtMs: eventTimestampMs,
      pools,
    };
  });

  const candidates = [];
  for (const launch of launches.filter(Boolean)) {
    for (const pool of launch.pools) {
      const quote = launch.quotes.find((item) => [pool.currency0, pool.currency1].includes(item.address));
      const candidate = createMomentumCandidate({
        pool,
        platform: launch.protocol === "pair" ? "Pair" : launch.protocol === "flap" ? "Flap" : "Long",
        project: launch.project,
        quote,
        launchTx: launch.launchTx,
        launchBlock: launch.launchBlock,
        launchedAtMs: launch.launchedAtMs,
      });
      if (candidate) candidates.push(candidate);
    }
  }

  const replayed = await mapLimit(candidates, 6, async (initial) => {
    const maxBlock = initial.launchBlock + Number(BLOCKS_PER_REPLAY);
    const logs = await getLogs(
      url,
      UNISWAP_V4_POOL_MANAGER,
      TOPIC0_UNISWAP_V4_SWAP,
      BigInt(initial.launchBlock),
      BigInt(maxBlock),
      initial.poolId
    );
    const byTx = new Map();
    for (const log of logs) {
      if (!byTx.has(log.transactionHash)) byTx.set(log.transactionHash, log);
    }
    const transactions = await mapLimit([...byTx.values()], 6, async (log) => {
      const [transaction, swapReceipt] = await rpcBatch(url, [
        { method: "eth_getTransactionByHash", params: [log.transactionHash] },
        { method: "eth_getTransactionReceipt", params: [log.transactionHash] },
      ]);
      if (!transaction || !swapReceipt) return null;
      const aggregate = aggregateV4Swaps(swapReceipt.logs, initial.poolId);
      if (!aggregate || aggregate.tx === initial.launchTx) return null;
      const tradeTimeMs = await timestampMs(aggregate.block, log.blockTimestamp);
      if (tradeTimeMs - initial.launchedAtMs > REPLAY_MS) return null;
      return normalizePoolTrade(initial, aggregate, {
        buyer: transaction.from,
        timestampMs: tradeTimeMs,
        quoteUsd: pricing.prices[initial.quote.address] ?? null,
      });
    });
    let candidate = initial;
    let firstSignal = null;
    const milestones = [];
    const trades = transactions.filter(Boolean).sort((a, b) => a.timestampMs - b.timestampMs);
    for (const trade of trades) {
      const result = recordCandidateTrade(candidate, trade);
      candidate = result.candidate;
      if (!firstSignal && result.shouldNotify) {
        firstSignal = { tx: trade.tx, reasons: result.reasons, metrics: result.metrics };
      }
      if (result.newMilestones.length) milestones.push({ tx: trade.tx, levels: result.newMilestones, metrics: result.metrics });
    }
    return {
      platform: candidate.platform,
      poolId: candidate.poolId,
      project: candidate.project,
      quote: candidate.quote,
      launchTx: candidate.launchTx,
      launchBlock: candidate.launchBlock,
      trades,
      firstSignal,
      milestones,
    };
  });

  const uniqueProjects = new Set(replayed.map((item) => item.project.address));
  const signaledProjects = new Set(replayed.filter((item) => item.firstSignal).map((item) => item.project.address));
  const report = {
    generatedAt: new Date().toISOString(),
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    blocks: { from: Number(fromBlock), to: Number(toBlock) },
    replayWindowMs: REPLAY_MS,
    pricing: { source: pricing.source, pricedAssets: Object.keys(pricing.prices).length, error: pricing.error || null },
    summary: {
      protocolEvents: boundedProtocolLogs.length,
      stockLaunches: launches.filter(Boolean).length,
      pools: replayed.length,
      uniqueProjects: uniqueProjects.size,
      swapTransactions: replayed.reduce((sum, item) => sum + item.trades.length, 0),
      signaledProjects: signaledProjects.size,
      reductionPercent: uniqueProjects.size ? (1 - signaledProjects.size / uniqueProjects.size) * 100 : 0,
    },
    signals: replayed
      .filter((item) => item.firstSignal)
      .map((item) => ({
        platform: item.platform,
        ticker: item.project.symbol,
        projectAddress: item.project.address,
        quote: item.quote.symbol,
        poolId: item.poolId,
        launchTx: item.launchTx,
        ...item.firstSignal,
      })),
    candidates: replayed,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ outputPath, ...report.summary, pricing: report.pricing }, null, 2));
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
