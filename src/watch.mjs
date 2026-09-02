import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PONS_FACTORY,
  TOPIC0_APPROVAL,
  RH_ASSETS_URL,
  DEFAULT_RPC,
  LOG_CHUNK,
  hexToBigInt,
  toHex,
  decodeApprovalLog,
  extractRhAssets,
  diffRhAssets,
  applyPonsLogs,
  buildEmbed,
  emptyState,
} from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, "state", "seen.json");
const UA = "stock-pair-alerts/1.1";
const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());

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
  const body = await httpJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body.error) throw new Error(method + " via " + url + ": " + (body.error.message || "rpc error"));
  return body.result;
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

async function getLogsChunked(rpcUrl, fromBlock, toBlock) {
  const logs = [];
  let start = fromBlock;
  while (start <= toBlock) {
    let end = start + LOG_CHUNK - 1n;
    if (end > toBlock) end = toBlock;
    const chunk = await rpc(rpcUrl, "eth_getLogs", [{
      address: PONS_FACTORY,
      fromBlock: toHex(start),
      toBlock: toHex(end),
      topics: [TOPIC0_APPROVAL],
    }]);
    logs.push(...(chunk || []));
    start = end + 1n;
  }
  return logs;
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
    if (from <= latest) ponsLogs = await getLogsChunked(usedRpc, from, latest);
  }

  const pons = applyPonsLogs(state, ponsLogs.map(decodeApprovalLog).filter(Boolean));
  if (pons.ponsLastBlock < Number(latest)) pons.ponsLastBlock = Number(latest);

  const nextRh = extractRhAssets(await httpJson(RH_ASSETS_URL));
  const newRh = state.initialized ? diffRhAssets(state.rhAssets || {}, nextRh) : [];

  const alerts = [];
  if (state.initialized) {
    for (const e of pons.alerts) {
      const meta = nextRh[e.pairToken] || {};
      alerts.push({ platform: "Pons", symbol: meta.symbol, name: meta.name, address: e.pairToken, tx: e.tx });
    }
    for (const asset of newRh) {
      alerts.push({
        platform: "Long / RH catalog",
        symbol: asset.symbol,
        name: asset.name,
        address: asset.address,
        extra: "New Robinhood stock token, pairable on Long.",
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
    rhAssets: nextRh,
  }, null, 2) + "\n");

  console.log(JSON.stringify({
    usedRpc: usedRpc.split("/v2/")[0],
    dryRun,
    initializedBefore: state.initialized,
    latestBlock: Number(latest),
    ponsLogs: ponsLogs.length,
    rhCount: Object.keys(nextRh).length,
    posted: dryRun ? 0 : alerts.length,
  }));
}

main().catch(fail);
