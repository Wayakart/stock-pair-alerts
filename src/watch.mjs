import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PONS_FACTORY,
  TOPIC0_APPROVAL,
  LONG_LAUNCHER,
  TOPIC0_LAUNCH,
  RH_ASSETS_URL,
  DEFAULT_RPC,
  LOG_CHUNK,
  hexToBigInt,
  toHex,
  decodeApprovalLog,
  decodeLaunchLog,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  buildEmbed,
  emptyState,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, "state", "seen.json");
const UA = "stock-pair-alerts/1.3";
const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveRpcUrl(raw) {
  const v = String(raw || "").trim();
  if (!v) return DEFAULT_RPC;
  if (/^https?:\/\//i.test(v)) return v;
  return "https://robinhood-mainnet.g.alchemy.com/v2/" + v;
}

function fail(err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(msg);
  console.error("::error::" + String(err && err.message ? err.message : err));
  process.exit(1);
}

function isRateLimit(err) {
  return /429|too many|capacity|rate limit|compute units|deadline exceeded|timed out|timeout|ETIMEDOUT|ECONNRESET|502|503|504/i.test(String(err && err.message ? err.message : err));
}

function isRangeError(err) {
  return /block range|query returned more|too large|response size/i.test(String(err && err.message ? err.message : err));
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

async function rpc(url, method, params) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const body = await httpJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (body.error) {
        const err = new Error(method + " via " + url + ": " + (body.error.message || "rpc error"));
        if (isRateLimit(err) && i < 5) {
          lastErr = err;
          await sleep(400 * 2 ** i);
          continue;
        }
        throw err;
      }
      return body.result;
    } catch (err) {
      lastErr = err;
      if (isRateLimit(err) && i < 5) {
        await sleep(400 * 2 ** i);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function rpcWithFallback(primary, method, params) {
  try {
    return { url: primary, result: await rpc(primary, method, params) };
  } catch (err) {
    if (primary === DEFAULT_RPC) throw err;
    console.warn("primary RPC failed, falling back to public RPC:", err.message);
    return { url: DEFAULT_RPC, result: await rpc(DEFAULT_RPC, method, params) };
  }
}

async function getLogsBudgeted(rpcUrl, fromBlock, toBlock, address, topic0, { chunk, budgetMs, minGapMs }) {
  const logs = [];
  let start = fromBlock;
  let size = chunk;
  let url = rpcUrl;
  let lastCall = 0;
  const t0 = Date.now();
  while (start <= toBlock) {
    if (budgetMs && Date.now() - t0 > budgetMs) {
      return { logs, scannedTo: start - 1n, done: false, url };
    }
    let end = start + size - 1n;
    if (end > toBlock) end = toBlock;
    const gap = minGapMs || 0;
    if (gap) {
      const wait = lastCall + gap - Date.now();
      if (wait > 0) await sleep(wait);
    }
    lastCall = Date.now();
    try {
      const chunkLogs = await rpc(url, "eth_getLogs", [{
        address,
        fromBlock: toHex(start),
        toBlock: toHex(end),
        topics: [topic0],
      }]);
      logs.push(...(chunkLogs || []));
      start = end + 1n;
      if (size < chunk) {
        const grown = size * 2n;
        size = grown > chunk ? chunk : grown;
      }
    } catch (err) {
      if (isRateLimit(err) && url !== DEFAULT_RPC) {
        console.warn("rate limited, switching Long/Pons logs to public RPC");
        url = DEFAULT_RPC;
        continue;
      }
      if (isRateLimit(err)) {
        console.warn("still rate limited, saving progress and stopping this run");
        return { logs, scannedTo: start - 1n, done: false, url };
      }
      if (isRangeError(err) && size > 1n) {
        console.warn("getLogs range failed, shrinking", size.toString(), err.message);
        size = size / 2n;
        if (size < 1n) size = 1n;
        continue;
      }
      throw err;
    }
  }
  return { logs, scannedTo: toBlock, done: true, url };
}

async function notify(webhooks, embed) {
  const payload = JSON.stringify({ username: "stock pair alerts", embeds: [embed] });
  for (const url of webhooks) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: payload,
    });
    if (![200, 204].includes(res.status)) {
      throw new Error("Discord " + res.status + " " + (await res.text()).slice(0, 120));
    }
  }
}

function webhooksFromEnv() {
  return [process.env.DISCORD_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL_2].filter(
    (u) => u && u.startsWith("https://")
  );
}

async function main() {
  const dryRun = truthy(process.env.DRY_RUN);
  const testPing = truthy(process.env.TEST_PING);
  const rpcUrl = resolveRpcUrl(process.env.RPC_URL);
  const hooks = webhooksFromEnv();
  console.log(JSON.stringify({
    node: process.version,
    rpcHost: rpcUrl.split("/v2/")[0],
    hasWebhook: hooks.length > 0,
    dryRun,
    testPing,
  }));

  if (testPing) {
    if (!hooks.length) throw new Error("test_ping requested but DISCORD_WEBHOOK_URL secret is missing");
    if (!dryRun) {
      await notify(hooks, {
        title: "Watcher alive",
        description: "stock-pair-alerts poller is running.",
        color: 0x0984e3,
        timestamp: new Date().toISOString(),
      });
      console.log("Posted watcher-alive ping.");
    }
  }

  let state;
  try {
    state = { ...emptyState(), ...JSON.parse(await fs.readFile(statePath, "utf8")) };
  } catch {
    state = emptyState();
  }

  const { url: usedRpc, result: latestHex } = await rpcWithFallback(rpcUrl, "eth_blockNumber", []);
  const latest = hexToBigInt(latestHex);

  let ponsLogs = [];
  if (state.initialized && state.ponsLastBlock) {
    const from = BigInt(state.ponsLastBlock) + 1n;
    if (from <= latest) {
      const ponsScan = await getLogsBudgeted(usedRpc, from, latest, PONS_FACTORY, TOPIC0_APPROVAL, {
        chunk: LOG_CHUNK,
        budgetMs: 0,
        minGapMs: 200,
      });
      ponsLogs = ponsScan.logs;
    }
  }

  const pons = applyPonsLogs(state, ponsLogs.map(decodeApprovalLog).filter(Boolean));
  if (pons.ponsLastBlock < Number(latest)) pons.ponsLastBlock = Number(latest);

  const nextRh = extractRhAssets(await httpJson(RH_ASSETS_URL));

  let longReady = Boolean(state.longReady);
  let longScan = { logs: [], scannedTo: -1n, done: true };
  if (!longReady) {
    console.warn("long snapshot not ready; skipping Long this run (Pons still watched)");
  } else {
    const longFrom = BigInt(state.longLastBlock || 0) + 1n;
    longScan = { logs: [], scannedTo: longFrom - 1n, done: longFrom > latest };
    if (longFrom <= latest) {
      longScan = await getLogsBudgeted(usedRpc, longFrom, latest, LONG_LAUNCHER, TOPIC0_LAUNCH, {
        chunk: LOG_CHUNK,
        budgetMs: 45_000,
        minGapMs: 200,
      });
    }
  }
  const longEvents = longScan.logs.map(decodeLaunchLog).filter(Boolean);
  const long = applyLongLogs(state, longEvents, {
    rhMap: nextRh,
    allowAlerts: longReady,
  });
  if (longScan.scannedTo >= 0n && Number(longScan.scannedTo) > long.longLastBlock) {
    long.longLastBlock = Number(longScan.scannedTo);
  }
  if (!state.longReady) longReady = false;

  const alerts = [];
  if (state.initialized) {
    for (const e of pons.alerts) {
      const meta = nextRh[e.pairToken] || {};
      alerts.push({ platform: "Pons", symbol: meta.symbol, name: meta.name, address: e.pairToken, tx: e.tx });
    }
  }
  if (longReady && state.longReady) {
    for (const e of long.alerts) {
      const meta = nextRh[e.numeraire] || {};
      alerts.push({
        platform: "Long",
        symbol: meta.symbol,
        name: meta.name,
        address: e.numeraire,
        tx: e.tx,
        extra: "First Long pair against this stock.",
      });
    }
  }

  if (!dryRun && hooks.length) {
    for (const a of alerts) await notify(hooks, buildEmbed(a));
  } else if (alerts.length && !hooks.length) {
    console.warn("alerts ready but DISCORD_WEBHOOK_URL is not set");
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    initialized: true,
    ponsLastBlock: pons.ponsLastBlock,
    ponsApproved: pons.ponsApproved,
    longLastBlock: long.longLastBlock,
    longNumeraires: long.longNumeraires,
    longReady,
  }, null, 2) + "\n");

  console.log(JSON.stringify({
    usedRpc: usedRpc.split("/v2/")[0],
    dryRun,
    initializedBefore: state.initialized,
    latestBlock: Number(latest),
    ponsLogs: ponsLogs.length,
    longLogs: longScan.logs.length,
    longReady,
    longNumeraires: long.longNumeraires.length,
    rhCount: Object.keys(nextRh).length,
    posted: dryRun ? 0 : alerts.length,
  }));
}

main().catch(fail);
