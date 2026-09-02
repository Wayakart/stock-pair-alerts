export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
export const TOPIC0_APPROVAL =
  "0x060d1992d069dc524985f328329aae36102a017c59733c5c91fc0691ee0703b6";
export const LONG_LAUNCHER = "0x22e99278308B393ea1260859B181AD7E78f5eeED";
export const TOPIC0_LAUNCH =
  "0xadc6f1f726f7c710f77ec06adc75f3bb964e5be19581b072c67f7b9b4039267b";
export const LONG_START_BLOCK = 8636038;
export const RH_ASSETS_URL = "https://api.robinhood.com/rhj/assets";
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const CHAIN_ID = 4663;
export const LOG_CHUNK = 2_000n;
export const LONG_LOG_CHUNK = 10_000n;
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const ZERO = "0x0000000000000000000000000000000000000000";

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

export function isStockNumeraire(addr, rhMap) {
  const a = normalizeAddr(addr);
  if (!a || a === ZERO || a === USDG || a === WETH) return false;
  return Boolean(rhMap && rhMap[a]);
}

export function extractRhAssets(payload) {
  const byAddr = {};
  for (const asset of payload.assets || []) {
    if (asset.status && asset.status !== "ASSET_STATUS_ACTIVE") continue;
    for (const d of asset.deployments || []) {
      if (Number(d.chainId) !== CHAIN_ID || !d.contractAddress) continue;
      const address = normalizeAddr(d.contractAddress);
      byAddr[address] = {
        address,
        symbol: asset.tokenSymbol || "UNKNOWN",
        name: asset.tokenName || "",
        logo: asset.logoUrl || "",
      };
    }
  }
  return byAddr;
}

export function applyPonsLogs(state, events) {
  const approved = new Set((state.ponsApproved || []).map(normalizeAddr));
  let lastBlock = state.ponsLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    if (e.approved) {
      const isNew = !approved.has(e.pairToken);
      approved.add(e.pairToken);
      if (isNew && state.initialized) alerts.push(e);
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
  const seen = new Set((state.longNumeraires || []).map(normalizeAddr));
  let lastBlock = state.longLastBlock || 0;
  const alerts = [];
  const sorted = [...events].sort((a, b) => a.block - b.block);
  for (const e of sorted) {
    if (e.block > lastBlock) lastBlock = e.block;
    const addr = normalizeAddr(e.numeraire);
    if (!addr) continue;
    const isNew = !seen.has(addr);
    seen.add(addr);
    if (isNew && allowAlerts && isStockNumeraire(addr, rhMap)) alerts.push(e);
  }
  return {
    longNumeraires: [...seen],
    longLastBlock: lastBlock,
    alerts,
  };
}

export function buildEmbed({ platform, symbol, name, address, tx, extra }) {
  const fields = [
    { name: "Platform", value: platform, inline: true },
    { name: "Ticker", value: symbol || "?", inline: true },
    { name: "Address", value: "`" + address + "`", inline: false },
  ];
  if (name) fields.push({ name: "Name", value: name, inline: false });
  if (tx) {
    fields.push({
      name: "Tx",
      value: "[" + tx.slice(0, 10) + "…](" + EXPLORER + "/tx/" + tx + ")",
      inline: false,
    });
  }
  if (extra) fields.push({ name: "Note", value: extra, inline: false });
  return {
    title: platform + " listed " + (symbol || "a new pair stock"),
    url: EXPLORER + "/address/" + address,
    color: platform === "Pons" ? 0x6c5ce7 : 0x00b894,
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function emptyState() {
  return {
    initialized: false,
    ponsLastBlock: 0,
    ponsApproved: [],
    longLastBlock: 0,
    longNumeraires: [],
    longReady: false,
    rhAssets: {},
  };
}
