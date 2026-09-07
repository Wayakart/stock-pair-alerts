import fs from "node:fs/promises";
import WebSocket from "ws";
import { logJson, msSince } from "./metrics.mjs";
import { PUMP_PROGRAM, redactUrl } from "./lib.mjs";

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : "";
}

async function loadEnvFile(file) {
  if (!file) return;
  const text = await fs.readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=");
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

async function measureHttpRpc({ name, url, method, params = [], samples }) {
  const latencies = [];
  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: i + 1, method, params }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(name + " " + JSON.stringify(body.error || body));
    latencies.push(msSince(start));
  }
  return summarize({ name, kind: "http-rpc", url, latencies });
}

async function measureWsRpc({ name, url, method, params = [], samples }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const latencies = [];
    const starts = new Map();
    let nextId = 1;

    const finish = (err) => {
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(summarize({ name, kind: "ws-rpc", url, latencies }));
    };

    ws.on("open", () => {
      for (let i = 0; i < samples; i++) {
        const id = nextId++;
        starts.set(id, process.hrtime.bigint());
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.error) return finish(new Error(name + " " + JSON.stringify(msg.error)));
      if (!starts.has(msg.id)) return;
      latencies.push(msSince(starts.get(msg.id)));
      starts.delete(msg.id);
      if (latencies.length >= samples) finish();
    });
    ws.on("error", finish);
  });
}

function summarize({ name, kind, url, latencies }) {
  return {
    name,
    kind,
    url: redactUrl(url),
    samples: latencies.length,
    minMs: percentile(latencies, 0),
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: percentile(latencies, 100),
  };
}

async function main() {
  await loadEnvFile(argValue("--env"));
  const samples = Number(argValue("--samples") || process.env.BENCHMARK_SAMPLES || 10);
  const results = [];
  if (process.env.REALTIME_RPC_WS_URL) {
    results.push(await measureWsRpc({
      name: "quicknode-robinhood",
      url: process.env.REALTIME_RPC_WS_URL,
      method: "eth_blockNumber",
      samples,
    }));
  }
  if (process.env.SOLANA_RPC_HTTP_URL) {
    results.push(await measureHttpRpc({
      name: "helius-solana-http",
      url: process.env.SOLANA_RPC_HTTP_URL,
      method: "getHealth",
      samples,
    }));
  }
  if (process.env.SOLANA_RPC_WS_URL) {
    results.push(await measureWsRpc({
      name: "helius-laserstream-wss",
      url: process.env.SOLANA_RPC_WS_URL,
      method: "logsSubscribe",
      params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }],
      samples: 1,
    }));
  }
  logJson("provider_benchmark", { samples, results });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
