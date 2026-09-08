import bs58 from "bs58";

export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const TOPIC0_APPROVAL =
  "0x060d1992d069dc524985f328329aae36102a017c59733c5c91fc0691ee0703b6";
export const LONG_LAUNCHER = "0x22e99278308B393ea1260859B181AD7E78f5eeED";
export const TOPIC0_LAUNCH =
  "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b";
export const FLAP_ROUTER = "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09";
export const TOPIC0_FLAP_TOKEN_QUOTE_SET =
  "0x3ceb902d3c555c21c3415b6aa839104b18e4825b2f8324011ff979089a507a8c";
export const PAIR_LAUNCHPAD = "0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62";
export const PAIR_COORDINATOR = "0xf98b202fd8717b79f9c5e5dd67c2f9e640bbd25d";
export const PAIR_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED =
  "0xc1b1fb8d1b8316a5e3daeabb1eb94809ff0aae6bf9f8527dda4f5404ec11a100";
export const TOPIC0_PAIR_CANONICAL_POOL_LAUNCHED =
  "0xc559f6b695e21adfebe603206dc072989e931f9ade0683fda629d167476e6cdd";
export const TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED =
  "0x8aae1ddb61bb894868f4b1a037b2a84d5f25e02118d13a83e11eb3ebbeb9f076";
export const LONG_START_BLOCK = 8636038;
export const RH_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
export const O1_CATALOG_URL = "https://docs.o1.exchange/launchpad/reference/robinhood-stock-quotes.json";
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const SOLANA_EXPLORER = "https://solscan.io";
export const CHAIN_ID = 4663;
export const LOG_CHUNK = 2_000n;
export const LONG_LOG_CHUNK = 10_000n;
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const STONKFUN_PAIRS_URL = "https://www.stonkfun.xyz/api/public/v1/pairs?launchable=true";
export const PUMP_CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

export function logsRpcUrl(rpcUrl, defaultRpc) {
  return /alchemy\.com/i.test(String(rpcUrl || "")) ? defaultRpc : rpcUrl;
}

export function parseMaxBlockRange(err) {
  const m = String(err && err.message ? err.message : err).match(/up to a (\d+) block range/i);
  return m ? BigInt(m[1]) : null;
}

export function shrinkLogChunk(size, maxSize) {
  let nextMax = size - 1n;
  if (nextMax < 1n) nextMax = 1n;
  if (maxSize < nextMax) nextMax = maxSize;
  let next = size / 2n;
  if (next > nextMax) next = nextMax;
  if (next < 1n) next = 1n;
  return { size: next, maxSize: nextMax };
}

export function growLogChunk(size, maxSize) {
  if (size >= maxSize) return size;
  const grown = size * 2n;
  return grown > maxSize ? maxSize : grown;
}

export function redactUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    url.username = url.username ? "REDACTED" : "";
    url.password = url.password ? "REDACTED" : "";
    for (const key of [...url.searchParams.keys()]) {
      if (/api|key|token|secret|auth/i.test(key)) url.searchParams.set(key, "REDACTED");
    }
    if (/quiknode\.pro$/i.test(url.hostname)) {
      url.pathname = url.pathname === "/" ? "/" : "/REDACTED/";
    }
    return url.toString();
  } catch {
    return String(raw || "").replace(/(api-key=)[^&\s]+/gi, "$1REDACTED");
  }
}


export function normalizeAddr(addr) {
  if (!addr) return "";
  const hex = addr.toLowerCase().replace(/^0x/, "");
  return "0x" + hex.padStart(40, "0");
}

export function hexToBigInt(hex) {
  if (hex === undefined || hex === null || hex === "") return 0n;
  return BigInt(hex);
}

export function toHex(n) {
  return "0x" + BigInt(n).toString(16);
}

export function decodeApprovalLog(log) {
  const topics = log.topics || [];
  if (!topics.length) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_APPROVAL) return null;
  const pairToken = normalizeAddr("0x" + String(topics[1]).slice(-40));
  const data = String(log.data || "0x").replace(/^0x/, "") || "0";
  const approved = BigInt("0x" + data) === 1n;
  return {
    pairToken,
    approved,
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function decodeLaunchLog(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_LAUNCH) return null;
  return {
    poolOrHook: normalizeAddr("0x" + String(topics[1]).slice(-40)),
    asset: normalizeAddr("0x" + String(topics[2]).slice(-40)),
    numeraire: normalizeAddr("0x" + String(topics[3]).slice(-40)),
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function decodeFlapQuoteSetLog(log) {
  const topics = log.topics || [];
  if (!topics.length) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_FLAP_TOKEN_QUOTE_SET) return null;
  const data = String(log.data || "0x").replace(/^0x/, "");
  if (data.length < 128) return null;
  return {
    token: normalizeAddr("0x" + data.slice(24, 64)),
    quote: normalizeAddr("0x" + data.slice(88, 128)),
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function decodePairCustomQuotePoolLog(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED) return null;
  return {
    project: normalizeAddr("0x" + String(topics[1]).slice(-40)),
    quote: normalizeAddr("0x" + String(topics[2]).slice(-40)),
    poolId: String(topics[3]).toLowerCase(),
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function decodePairCanonicalProjectLog(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED) return null;
  return {
    project: normalizeAddr("0x" + String(topics[1]).slice(-40)),
    creator: normalizeAddr("0x" + String(topics[2]).slice(-40)),
    vault: normalizeAddr("0x" + String(topics[3]).slice(-40)),
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function decodePairCanonicalPoolLog(log) {
  const topics = log.topics || [];
  if (topics.length < 4) return null;
  if (String(topics[0]).toLowerCase() !== TOPIC0_PAIR_CANONICAL_POOL_LAUNCHED) return null;
  const data = String(log.data || "0x").replace(/^0x/, "");
  if (data.length < 64) return null;
  return {
    project: normalizeAddr("0x" + String(topics[1]).slice(-40)),
    vault: normalizeAddr("0x" + String(topics[2]).slice(-40)),
    quote: normalizeAddr("0x" + String(topics[3]).slice(-40)),
    poolId: "0x" + data.slice(0, 64).toLowerCase(),
    tx: log.transactionHash,
    block: Number(hexToBigInt(log.blockNumber)),
  };
}

export function isStockNumeraire(addr, rhMap) {
  const a = normalizeAddr(addr);
  if (!a || a === ZERO || a === USDG || a === WETH) return false;
  return Boolean(rhMap && rhMap[a]);
}

export function csvSet(raw, { normalize = (v) => v.toLowerCase() } = {}) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((v) => normalize(String(v).trim()))
      .filter(Boolean)
  );
}

export function uniqueWebhookUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    const url = String(value || "").trim().replace(/\/+$/, "");
    if (!url.startsWith("https://") || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function discordWebhookUrls(env = process.env) {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(env.DISCORD_ALERTS_ENABLED || "").trim().toLowerCase()
  );
  if (!enabled) return [];
  return uniqueWebhookUrls([env.DISCORD_WEBHOOK_URL, env.DISCORD_WEBHOOK_URL_2]);
}

export function isInterestingAsset({ address, symbol }, {
  includeSymbols = new Set(),
  excludeSymbols = new Set(),
  includeAddresses = new Set(),
  excludeAddresses = new Set(),
} = {}) {
  const addr = normalizeAddr(address);
  const sym = String(symbol || "").trim().toUpperCase();
  if (addr && excludeAddresses.has(addr)) return false;
  if (sym && excludeSymbols.has(sym)) return false;
  if (includeAddresses.size || includeSymbols.size) {
    return (addr && includeAddresses.has(addr)) || (sym && includeSymbols.has(sym));
  }
  return true;
}

export function isInterestingSolanaAsset({ address, symbol }, {
  includeSymbols = new Set(),
  excludeSymbols = new Set(),
  includeAddresses = new Set(),
  excludeAddresses = new Set(),
} = {}) {
  const addr = String(address || "").trim();
  const sym = String(symbol || "").trim().toUpperCase();
  if (addr && excludeAddresses.has(addr)) return false;
  if (sym && excludeSymbols.has(sym)) return false;
  if (includeAddresses.size || includeSymbols.size) {
    return (addr && includeAddresses.has(addr)) || (sym && includeSymbols.has(sym));
  }
  return true;
}

export function extractStonkfunStockPairs(payload) {
  const pairs = payload && payload.data && Array.isArray(payload.data.pairs)
    ? payload.data.pairs
    : payload && Array.isArray(payload.pairs)
      ? payload.pairs
      : [];
  const out = {};
  for (const p of pairs) {
    const category = String(p.category || "").toLowerCase();
    if (!["xstock", "prestock", "sunrise"].includes(category)) continue;
    if (!p.mint) continue;
    out[p.mint] = {
      address: p.mint,
      symbol: p.symbol || "UNKNOWN",
      name: p.name || "",
      category,
    };
  }
  return out;
}

export function solanaAccountKeys(tx) {
  const keys = new Set();
  const add = (v) => {
    if (!v) return;
    if (typeof v === "string") keys.add(v);
    else if (typeof v.pubkey === "string") keys.add(v.pubkey);
  };
  for (const k of tx?.transaction?.message?.accountKeys || []) add(k);
  for (const ix of tx?.transaction?.message?.instructions || []) {
    add(ix.programId);
    for (const a of ix.accounts || []) add(a);
  }
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) {
      add(ix.programId);
      for (const a of ix.accounts || []) add(a);
    }
  }
  return keys;
}

function pumpInstructions(tx) {
  const out = [];
  for (const ix of tx?.transaction?.message?.instructions || []) out.push(ix);
  for (const group of tx?.meta?.innerInstructions || []) {
    for (const ix of group.instructions || []) out.push(ix);
  }
  return out.filter((ix) => {
    const program = typeof ix?.programId === "string" ? ix.programId : ix?.programId?.toString?.();
    return program === PUMP_PROGRAM;
  });
}

export function findPumpStockLaunch(tx, stockMap) {
  const keys = solanaAccountKeys(tx);
  if (!keys.has(PUMP_PROGRAM)) return null;
  const hit = [...keys].find((k) => stockMap && stockMap[k]);
  if (!hit) return null;
  const instruction = pumpInstructions(tx)[0];
  const mintAccount = instruction?.accounts?.[0];
  const mint = typeof mintAccount === "string" ? mintAccount : mintAccount?.pubkey;
  const sig = tx?.transaction?.signatures?.[0];
  return {
    mint: mint || "",
    quoteMint: hit,
    signature: sig,
    slot: tx?.slot || 0,
  };
}

class BorshReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  take(size) {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.buffer.length) {
      throw new Error("Pump CreateEvent data is truncated");
    }
    const value = this.buffer.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }

  u32() {
    return this.take(4).readUInt32LE(0);
  }

  u64() {
    return this.take(8).readBigUInt64LE(0);
  }

  i64() {
    return this.take(8).readBigInt64LE(0);
  }

  bool() {
    return this.take(1)[0] !== 0;
  }

  string() {
    return this.take(this.u32()).toString("utf8");
  }

  pubkey() {
    return bs58.encode(this.take(32));
  }
}

export function decodePumpCreateEvent(logs) {
  for (const line of logs || []) {
    const match = String(line).match(/^Program data:\s*([A-Za-z0-9+/=]+)\s*$/);
    if (!match) continue;
    let data;
    try {
      data = Buffer.from(match[1], "base64");
    } catch {
      continue;
    }
    if (data.length < 8 || !data.subarray(0, 8).equals(PUMP_CREATE_EVENT_DISCRIMINATOR)) continue;
    try {
      const reader = new BorshReader(data.subarray(8));
      const event = {
        name: reader.string(),
        symbol: reader.string(),
        uri: reader.string(),
        mint: reader.pubkey(),
        bondingCurve: reader.pubkey(),
        user: reader.pubkey(),
        creator: reader.pubkey(),
        timestamp: reader.i64(),
        virtualTokenReserves: reader.u64(),
        virtualSolReserves: reader.u64(),
        realTokenReserves: reader.u64(),
        tokenTotalSupply: reader.u64(),
        tokenProgram: reader.pubkey(),
        isMayhemMode: reader.bool(),
        isCashbackEnabled: reader.bool(),
        quoteMint: reader.pubkey(),
        virtualQuoteReserves: reader.u64(),
      };
      return event;
    } catch {
      continue;
    }
  }
  return null;
}

export function isPumpCreateLog(logs) {
  return (logs || []).some((line) => /Instruction:\s*Create(?:V2)?\b/i.test(line));
}

export function applyPumpStockLaunches(state, events, { stockMap, allowAlerts } = {}) {
  const seen = new Set(state.pumpStockLaunches || []);
  const alerts = [];
  for (const e of events) {
    const key = e.signature || (e.slot + ":" + e.quoteMint);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (allowAlerts && stockMap && stockMap[e.quoteMint]) alerts.push(e);
  }
  return {
    pumpStockLaunches: [...seen],
    alerts,
  };
}

export function extractRhAssets(payload) {
  const byAddr = {};
  for (const asset of payload.assets || []) {
    if (asset.status && asset.status !== "ASSET_STATUS_ACTIVE") continue;
    for (const d of asset.deployments || []) {
      if (Number(d.chainId) !== CHAIN_ID || !d.contractAddress) continue;
      const address = normalizeAddr(d.contractAddress);
      const currentMultiplier = Number(asset.currentMultiplier || 1);
      const decimals = Number(asset.tokenDecimals ?? 18);
      byAddr[address] = {
        address,
        symbol: asset.tokenSymbol || "UNKNOWN",
        name: asset.tokenName || "",
        logo: asset.logoUrl || "",
        currentMultiplier: Number.isFinite(currentMultiplier) && currentMultiplier > 0 ? currentMultiplier : 1,
        decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18,
      };
    }
  }
  return byAddr;
}

export function extractO1Quotes(payload) {
  const out = [];
  for (const q of payload.quotes || []) {
    const address = normalizeAddr(q.address);
    if (!address || address === ZERO || address === USDG || address === WETH) continue;
    out.push({ address, symbol: q.symbol || "", name: q.name || "" });
  }
  return out;
}

export function applyO1Quotes(state, quotes) {
  const seen = new Set((state.o1Quotes || []).map(normalizeAddr));
  const hadSnapshot = seen.size > 0;
  const alerts = [];
  for (const q of quotes) {
    const addr = normalizeAddr(q.address);
    if (!addr) continue;
    if (!seen.has(addr)) {
      if (hadSnapshot) alerts.push(q);
      seen.add(addr);
    }
  }
  return { o1Quotes: [...seen], alerts };
}

export function applyPonsLogs(state, events, { allowAlerts = state.initialized } = {}) {
  const approved = new Set((state.ponsApproved || []).map(normalizeAddr));
  let lastBlock = state.ponsLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    if (e.approved) {
      const isNew = !approved.has(e.pairToken);
      approved.add(e.pairToken);
      if (isNew && allowAlerts) alerts.push(e);
    } else {
      approved.delete(e.pairToken);
    }
  }
  return {
    ponsApproved: [...approved],
    ponsLastBlock: lastBlock,
    alerts,
  };
}

export function applyLongLogs(state, events, { rhMap, allowAlerts } = {}) {
  const seen = new Set((state.longLaunches || []).map((v) => String(v).toLowerCase()));
  const numeraires = new Set((state.longNumeraires || []).map(normalizeAddr));
  let lastBlock = state.longLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    const addr = normalizeAddr(e.numeraire);
    if (!addr) continue;
    const launchKey = String(e.tx || (e.poolOrHook + ":" + e.asset + ":" + addr)).toLowerCase();
    const isNew = !seen.has(launchKey);
    seen.add(launchKey);
    numeraires.add(addr);
    if (isNew && allowAlerts && isStockNumeraire(addr, rhMap)) alerts.push(e);
  }
  return {
    longLaunches: [...seen],
    longNumeraires: [...numeraires],
    longLastBlock: lastBlock,
    alerts,
  };
}

export function applyFlapQuoteLogs(state, events, { rhMap, allowAlerts } = {}) {
  const seen = new Set((state.flapPairs || []).map((v) => String(v).toLowerCase()));
  let lastBlock = state.flapLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    const token = normalizeAddr(e.token);
    const quote = normalizeAddr(e.quote);
    if (!token || !quote) continue;
    const pairKey = token + ":" + quote;
    const isNew = !seen.has(pairKey);
    seen.add(pairKey);
    if (isNew && allowAlerts && isStockNumeraire(quote, rhMap)) alerts.push(e);
  }
  return {
    flapPairs: [...seen],
    flapLastBlock: lastBlock,
    alerts,
  };
}

export function applyPairPoolLogs(state, events, { rhMap, allowAlerts } = {}) {
  const seen = new Set((state.pairPools || []).map((v) => String(v).toLowerCase()));
  let lastBlock = state.pairLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    const project = normalizeAddr(e.project);
    const quote = normalizeAddr(e.quote);
    const poolId = String(e.poolId || "").toLowerCase();
    if (!project || !quote || !poolId) continue;
    const pairKey = project + ":" + quote + ":" + poolId;
    const isNew = !seen.has(pairKey);
    seen.add(pairKey);
    if (isNew && allowAlerts && isStockNumeraire(quote, rhMap)) alerts.push(e);
  }
  return {
    pairPools: [...seen],
    pairLastBlock: lastBlock,
    alerts,
  };
}

export function applyPairLaunches(state, events, { allowAlerts } = {}) {
  const seen = new Set((state.pairLaunches || []).map((v) => String(v).toLowerCase()));
  let lastBlock = state.pairLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const event of sorted) {
    if (event.block > lastBlock) lastBlock = event.block;
    const project = normalizeAddr(event.project);
    const key = String(event.tx || project).toLowerCase();
    if (!project || !key || seen.has(key)) continue;
    seen.add(key);
    if (allowAlerts) alerts.push(event);
  }
  return { pairLaunches: [...seen], pairLastBlock: lastBlock, alerts };
}

export function decodeAbiString(hex) {
  const raw = String(hex || "").replace(/^0x/, "");
  if (!raw || raw.length % 2 !== 0) return "";
  const data = Buffer.from(raw, "hex");
  try {
    if (data.length >= 64) {
      const offset = Number(BigInt("0x" + data.subarray(0, 32).toString("hex")));
      if (Number.isSafeInteger(offset) && offset >= 0 && offset + 32 <= data.length) {
        const length = Number(BigInt("0x" + data.subarray(offset, offset + 32).toString("hex")));
        if (Number.isSafeInteger(length) && length >= 0 && offset + 32 + length <= data.length) {
          return data.subarray(offset + 32, offset + 32 + length).toString("utf8").replace(/\0/g, "").trim();
        }
      }
    }
    return data.subarray(0, 32).toString("utf8").replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

function alertProject(alert) {
  return {
    address: alert.projectAddress || alert.address || "",
    symbol: alert.projectSymbol || alert.symbol || "",
    name: alert.projectName || alert.name || "",
  };
}

export function rickScanCommand(alert) {
  const project = alertProject(alert);
  if (!project.address) return "";
  return alert.chain === "solana" || alert.platform === "Pump.fun"
    ? ".pf " + project.address
    : ".x " + project.address;
}

export function buildEmbed(alert) {
  const { platform, tx, extra } = alert;
  const project = alertProject(alert);
  const quotes = Array.isArray(alert.quotes) ? alert.quotes.filter(Boolean) : [];
  const fields = [
    { name: "Platform", value: platform, inline: true },
    { name: "New token", value: project.symbol ? "$" + project.symbol : "Unknown", inline: true },
    { name: "Contract address", value: "`" + project.address + "`", inline: false },
  ];
  if (project.name) fields.push({ name: "Name", value: project.name, inline: false });
  if (quotes.length) {
    fields.push({
      name: "Paired with",
      value: quotes.map((quote) => quote.symbol || quote.name || quote.address).join(" | ").slice(0, 1024),
      inline: false,
    });
    fields.push({
      name: "Quote contracts",
      value: quotes.map((quote) => (quote.symbol ? quote.symbol + ": " : "") + "`" + quote.address + "`").join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (alert.signal) {
    const signal = alert.signal;
    fields.push({ name: "Signal", value: (signal.reasons || []).join(" | ") || "Qualified momentum", inline: false });
    fields.push({ name: "Unique buyers", value: String(signal.uniqueBuyers ?? 0), inline: true });
    fields.push({
      name: "Buy volume",
      value: Number.isFinite(signal.buyVolumeUsd)
        ? "$" + Math.round(signal.buyVolumeUsd).toLocaleString("en-US")
        : Number(signal.quoteBuyVolume || 0).toFixed(4) + " " + (signal.quoteSymbol || "quote"),
      inline: true,
    });
    fields.push({ name: "Age", value: Number(signal.ageSeconds || 0).toFixed(1) + "s", inline: true });
    fields.push({
      name: "Follow-through",
      value: String(signal.followThroughBuyers ?? 0) + " new buyers / " + String(signal.buyBlockCount ?? 0) + " blocks",
      inline: true,
    });
    if (Number.isFinite(signal.netBuyVolumeUsd)) {
      fields.push({
        name: "Net buy flow",
        value: "$" + Math.round(signal.netBuyVolumeUsd).toLocaleString("en-US") +
          " / " + Number(signal.sellToBuyPercent || 0).toFixed(0) + "% sold",
        inline: true,
      });
    }
    if (Number.isFinite(signal.estimatedFdvUsd)) {
      fields.push({ name: "Estimated FDV", value: "$" + Math.round(signal.estimatedFdvUsd).toLocaleString("en-US"), inline: true });
    }
    if (Number(signal.maxSameBlockBuyers || 0) >= 2) {
      const supply = Number.isFinite(signal.bundleSupplyPercent)
        ? " / " + signal.bundleSupplyPercent.toFixed(2) + "% supply"
        : "";
      fields.push({ name: "Bundle indicator", value: signal.maxSameBlockBuyers + " buyers in one block" + supply, inline: true });
    }
    if (Number.isFinite(signal.topBuyerSharePercent)) {
      fields.push({ name: "Top buyer share", value: signal.topBuyerSharePercent.toFixed(1) + "%", inline: true });
    }
    if (signal.milestones?.length) {
      fields.push({ name: "FDV milestones", value: signal.milestones.map((level) => "$" + (level / 1_000) + "k").join(" | "), inline: false });
    }
  }
  if (tx) {
    fields.push({
      name: "Tx",
      value: "[" + tx.slice(0, 10) + "…](" + EXPLORER + "/tx/" + tx + ")",
      inline: false,
    });
  }
  const scan = rickScanCommand(alert);
  if (scan) fields.push({ name: "Rick scan", value: "`" + scan + "`", inline: false });
  if (extra) fields.push({ name: "Note", value: extra, inline: false });
  return {
    title: platform + " " + (alert.verb || "launched") + " " + (project.symbol ? "$" + project.symbol : "a new token"),
    url: EXPLORER + "/address/" + project.address,
    color: platform === "Pons" ? 0x6c5ce7 : platform === "01" ? 0xf39c12 : 0x00b894,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function buildSolanaEmbed(alert) {
  const { platform, tx, extra } = alert;
  const project = alertProject(alert);
  const quotes = Array.isArray(alert.quotes) ? alert.quotes.filter(Boolean) : [];
  const fields = [
    { name: "Platform", value: platform, inline: true },
    { name: "New token", value: project.symbol ? "$" + project.symbol : "Unknown", inline: true },
    { name: "Mint / CA", value: "`" + project.address + "`", inline: false },
  ];
  if (project.name) fields.push({ name: "Name", value: project.name, inline: false });
  if (quotes.length) {
    fields.push({
      name: "Paired with",
      value: quotes.map((quote) => quote.symbol || quote.name || quote.address).join(" | ").slice(0, 1024),
      inline: false,
    });
    fields.push({
      name: "Quote mints",
      value: quotes.map((quote) => (quote.symbol ? quote.symbol + ": " : "") + "`" + quote.address + "`").join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (tx) {
    fields.push({
      name: "Tx",
      value: "[" + tx.slice(0, 10) + "...](" + SOLANA_EXPLORER + "/tx/" + tx + ")",
      inline: false,
    });
  }
  const scan = rickScanCommand(alert);
  if (scan) fields.push({ name: "Rick scan", value: "`" + scan + "`", inline: false });
  if (extra) fields.push({ name: "Note", value: extra, inline: false });
  return {
    title: platform + " launched " + (project.symbol ? "$" + project.symbol : "a new token"),
    url: SOLANA_EXPLORER + "/token/" + project.address,
    color: 0x14f195,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function buildDiscordAlertPayload(alert, { rickAutoScan = false } = {}) {
  const embed = alert.chain === "solana" ? buildSolanaEmbed(alert) : buildEmbed(alert);
  const payload = { username: "stock pair alerts", embeds: [embed] };
  if (rickAutoScan) payload.content = rickScanCommand(alert);
  return payload;
}

export function buildStatusEmbed({ title, level = "info", service, message, fields = [] }) {
  const colors = { info: 0x3498db, warn: 0xf1c40f, error: 0xe74c3c };
  const out = {
    title,
    color: colors[level] || colors.info,
    fields: [
      { name: "Service", value: service || "stock-pair-alerts", inline: true },
      { name: "Message", value: message || "-", inline: false },
      ...fields,
    ],
    timestamp: new Date().toISOString(),
  };
  return out;
}

export function emptyState() {
  return {
    stateVersion: 3,
    initialized: false,
    ponsLastBlock: 0,
    ponsApproved: [],
    longLastBlock: 0,
    longLaunches: [],
    longNumeraires: [],
    longReady: false,
    flapLastBlock: 0,
    flapPairs: [],
    pairLastBlock: 0,
    pairLaunches: [],
    pairPools: [],
    pumpStockLaunches: [],
    pumpLastSlot: 0,
    pumpLastSignature: "",
    o1Quotes: [],
    rhAssets: {},
    momentumLastBlock: 0,
    momentumCandidates: {},
  };
}
