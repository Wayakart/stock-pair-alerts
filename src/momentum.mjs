import { PAIR_POOL_MANAGER, normalizeAddr } from "./lib.mjs";

export const UNISWAP_V4_POOL_MANAGER = normalizeAddr(PAIR_POOL_MANAGER);
export const TOPIC0_UNISWAP_V4_INITIALIZE =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const TOPIC0_UNISWAP_V4_SWAP =
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

export const DEFAULT_MOMENTUM_THRESHOLDS = Object.freeze({
  earlyWindowMs: 60_000,
  trackingWindowMs: 3_600_000,
  minUniqueBuyers: 3,
  minBuyVolumeUsd: 1_000,
  whaleBuyVolumeUsd: 5_000,
  minBundleBuyers: 3,
  walletFallbackBuyers: 5,
  fdvMilestonesUsd: [20_000, 50_000, 100_000],
});

function dataWords(data) {
  const raw = String(data || "0x").replace(/^0x/, "");
  if (!raw || raw.length % 64 !== 0) return [];
  return raw.match(/.{64}/g) || [];
}

function signedWord(word) {
  const value = BigInt("0x" + word);
  return value >= 1n << 255n ? value - (1n << 256n) : value;
}

function topicAddress(topic) {
  return normalizeAddr("0x" + String(topic || "").slice(-40));
}

function abs(value) {
  return value < 0n ? -value : value;
}

function units(value, decimals) {
  const scale = 10 ** Number(decimals || 0);
  const numeric = Number(value);
  return Number.isFinite(numeric) && Number.isFinite(scale) && scale > 0 ? numeric / scale : 0;
}

export function decodeV4InitializeLog(log) {
  const topics = log?.topics || [];
  const words = dataWords(log?.data);
  if (normalizeAddr(log?.address) !== UNISWAP_V4_POOL_MANAGER) return null;
  if (String(topics[0] || "").toLowerCase() !== TOPIC0_UNISWAP_V4_INITIALIZE) return null;
  if (topics.length < 4 || words.length < 5) return null;
  return {
    poolId: String(topics[1]).toLowerCase(),
    currency0: topicAddress(topics[2]),
    currency1: topicAddress(topics[3]),
    sqrtPriceX96: BigInt("0x" + words[3]),
    block: Number(BigInt(log.blockNumber || 0)),
    tx: log.transactionHash,
  };
}

export function decodeV4SwapLog(log) {
  const topics = log?.topics || [];
  const words = dataWords(log?.data);
  if (normalizeAddr(log?.address) !== UNISWAP_V4_POOL_MANAGER) return null;
  if (String(topics[0] || "").toLowerCase() !== TOPIC0_UNISWAP_V4_SWAP) return null;
  if (topics.length < 3 || words.length < 6) return null;
  return {
    poolId: String(topics[1]).toLowerCase(),
    sender: topicAddress(topics[2]),
    amount0: signedWord(words[0]),
    amount1: signedWord(words[1]),
    sqrtPriceX96: BigInt("0x" + words[2]),
    block: Number(BigInt(log.blockNumber || 0)),
    tx: log.transactionHash,
  };
}

export function aggregateV4Swaps(logs, poolId) {
  const swaps = (logs || []).map(decodeV4SwapLog).filter((swap) => swap?.poolId === String(poolId).toLowerCase());
  if (!swaps.length) return null;
  return {
    poolId: swaps[0].poolId,
    amount0: swaps.reduce((sum, swap) => sum + swap.amount0, 0n),
    amount1: swaps.reduce((sum, swap) => sum + swap.amount1, 0n),
    sqrtPriceX96: swaps.at(-1).sqrtPriceX96,
    block: swaps.at(-1).block,
    tx: swaps.at(-1).tx,
    swapCount: swaps.length,
  };
}

export function createMomentumCandidate({
  pool,
  platform,
  project,
  quote,
  launchTx,
  launchBlock,
  launchedAtMs,
}) {
  const projectAddress = normalizeAddr(project.address);
  const quoteAddress = normalizeAddr(quote.address);
  const projectIndex = pool.currency0 === projectAddress ? 0 : pool.currency1 === projectAddress ? 1 : -1;
  const quoteIndex = pool.currency0 === quoteAddress ? 0 : pool.currency1 === quoteAddress ? 1 : -1;
  if (projectIndex < 0 || quoteIndex < 0 || projectIndex === quoteIndex) return null;
  return {
    poolId: pool.poolId,
    platform,
    project: { ...project, address: projectAddress },
    quote: { ...quote, address: quoteAddress },
    currency0: pool.currency0,
    currency1: pool.currency1,
    projectIndex,
    quoteIndex,
    launchTx,
    launchBlock,
    launchedAtMs,
    initialSqrtPriceX96: pool.sqrtPriceX96.toString(),
    latestSqrtPriceX96: pool.sqrtPriceX96.toString(),
    processedTxs: [],
    trades: [],
    milestones: [],
    qualifiedAt: null,
    discordMessageIds: [],
  };
}

export function normalizePoolTrade(candidate, aggregate, { buyer, timestampMs, quoteUsd = null }) {
  const projectDelta = candidate.projectIndex === 0 ? aggregate.amount0 : aggregate.amount1;
  const quoteDelta = candidate.quoteIndex === 0 ? aggregate.amount0 : aggregate.amount1;
  const side = projectDelta > 0n && quoteDelta < 0n
    ? "buy"
    : projectDelta < 0n && quoteDelta > 0n
      ? "sell"
      : "other";
  const projectAmount = units(abs(projectDelta), candidate.project.decimals);
  const quoteAmount = units(abs(quoteDelta), candidate.quote.decimals);
  return {
    tx: aggregate.tx,
    buyer: normalizeAddr(buyer),
    block: aggregate.block,
    timestampMs,
    side,
    projectAmount,
    quoteAmount,
    quoteUsd: Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteUsd : null,
    volumeUsd: Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteAmount * quoteUsd : null,
    sqrtPriceX96: aggregate.sqrtPriceX96.toString(),
    swapCount: aggregate.swapCount,
  };
}

export function estimateFdvUsd(candidate, sqrtPriceX96, quoteUsd) {
  if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) return null;
  const supply = units(BigInt(candidate.project.totalSupply || 0), candidate.project.decimals);
  const sqrt = Number(BigInt(sqrtPriceX96 || 0));
  if (!Number.isFinite(supply) || supply <= 0 || !Number.isFinite(sqrt) || sqrt <= 0) return null;
  const rawPrice1Per0 = (sqrt / 2 ** 96) ** 2;
  const decimals0 = candidate.projectIndex === 0 ? candidate.project.decimals : candidate.quote.decimals;
  const decimals1 = candidate.projectIndex === 1 ? candidate.project.decimals : candidate.quote.decimals;
  const humanPrice1Per0 = rawPrice1Per0 * 10 ** (Number(decimals0) - Number(decimals1));
  const quotePerProject = candidate.projectIndex === 0 ? humanPrice1Per0 : 1 / humanPrice1Per0;
  const fdv = supply * quotePerProject * quoteUsd;
  return Number.isFinite(fdv) && fdv > 0 ? fdv : null;
}

function computeMetrics(candidate, thresholds) {
  const trades = candidate.trades || [];
  const buys = trades.filter((trade) => trade.side === "buy");
  const earlyBuys = buys.filter((trade) => trade.timestampMs - candidate.launchedAtMs <= thresholds.earlyWindowMs);
  const uniqueBuyers = new Set(earlyBuys.map((trade) => trade.buyer).filter(Boolean)).size;
  const quoteBuyVolume = earlyBuys.reduce((sum, trade) => sum + trade.quoteAmount, 0);
  const latestQuoteUsd = [...trades].reverse().find((trade) => trade.quoteUsd)?.quoteUsd || null;
  const buyVolumeUsd = latestQuoteUsd === null ? null : quoteBuyVolume * latestQuoteUsd;
  const projectSupply = units(BigInt(candidate.project.totalSupply || 0), candidate.project.decimals);
  const buyersByBlock = new Map();
  const tokensByBlock = new Map();
  const quoteByBuyer = new Map();
  for (const trade of earlyBuys) {
    if (!buyersByBlock.has(trade.block)) buyersByBlock.set(trade.block, new Set());
    buyersByBlock.get(trade.block).add(trade.buyer);
    tokensByBlock.set(trade.block, (tokensByBlock.get(trade.block) || 0) + trade.projectAmount);
    quoteByBuyer.set(trade.buyer, (quoteByBuyer.get(trade.buyer) || 0) + trade.quoteAmount);
  }
  const maxSameBlockBuyers = Math.max(0, ...[...buyersByBlock.values()].map((buyers) => buyers.size));
  const maxBlockTokens = Math.max(0, ...tokensByBlock.values());
  const bundleSupplyPercent = projectSupply > 0 ? (maxBlockTokens / projectSupply) * 100 : null;
  const largestBuyerQuote = Math.max(0, ...quoteByBuyer.values());
  const topBuyerSharePercent = quoteBuyVolume > 0 ? (largestBuyerQuote / quoteBuyVolume) * 100 : null;
  const latestTrade = trades.at(-1);
  const estimatedFdvUsd = estimateFdvUsd(candidate, latestTrade?.sqrtPriceX96 || candidate.latestSqrtPriceX96, latestQuoteUsd);
  const ageSeconds = latestTrade ? Math.max(0, (latestTrade.timestampMs - candidate.launchedAtMs) / 1_000) : 0;
  return {
    uniqueBuyers,
    buyVolumeUsd,
    quoteBuyVolume,
    maxSameBlockBuyers,
    bundleSupplyPercent,
    topBuyerSharePercent,
    estimatedFdvUsd,
    ageSeconds,
  };
}

export function recordCandidateTrade(candidate, trade, options = {}) {
  const thresholds = { ...DEFAULT_MOMENTUM_THRESHOLDS, ...options };
  const processedTxs = candidate.processedTxs || [];
  const trades = candidate.trades || [];
  if (processedTxs.includes(trade.tx)) {
    return { candidate, duplicate: true, metrics: computeMetrics(candidate, thresholds), reasons: [], newMilestones: [] };
  }
  const next = {
    ...candidate,
    processedTxs: [...processedTxs, trade.tx].slice(-500),
    trades: [...trades, trade]
      .filter((item) => trade.timestampMs - item.timestampMs <= thresholds.trackingWindowMs)
      .sort((a, b) => a.timestampMs - b.timestampMs),
    latestSqrtPriceX96: trade.sqrtPriceX96,
  };
  const metrics = computeMetrics(next, thresholds);
  const withinEarlyWindow = trade.timestampMs - next.launchedAtMs <= thresholds.earlyWindowMs;
  const reasons = [];
  if (withinEarlyWindow && metrics.buyVolumeUsd !== null && metrics.buyVolumeUsd >= thresholds.whaleBuyVolumeUsd) {
    reasons.push("whale buy volume");
  }
  if (withinEarlyWindow && metrics.uniqueBuyers >= thresholds.minUniqueBuyers &&
      metrics.buyVolumeUsd !== null && metrics.buyVolumeUsd >= thresholds.minBuyVolumeUsd) {
    reasons.push("early buyer momentum");
  }
  if (withinEarlyWindow && metrics.maxSameBlockBuyers >= thresholds.minBundleBuyers) {
    reasons.push("coordinated same-block buys");
  }
  if (withinEarlyWindow && metrics.buyVolumeUsd === null && metrics.uniqueBuyers >= thresholds.walletFallbackBuyers) {
    reasons.push("rapid wallet growth; USD quote unavailable");
  }
  const milestoneGate = metrics.uniqueBuyers >= thresholds.minUniqueBuyers ||
    (metrics.buyVolumeUsd !== null && metrics.buyVolumeUsd >= thresholds.minBuyVolumeUsd);
  const newMilestones = milestoneGate && metrics.estimatedFdvUsd !== null
    ? thresholds.fdvMilestonesUsd.filter((level) => metrics.estimatedFdvUsd >= level && !(next.milestones || []).includes(level))
    : [];
  if (newMilestones.length) reasons.push("estimated FDV milestone");
  const wasQualified = Boolean(next.qualifiedAt);
  if (!wasQualified && reasons.length) next.qualifiedAt = trade.timestampMs;
  next.milestones = [...(next.milestones || []), ...newMilestones].sort((a, b) => a - b);
  return {
    candidate: next,
    duplicate: false,
    metrics,
    reasons,
    newMilestones,
    shouldNotify: !wasQualified && reasons.length > 0,
    shouldUpdate: wasQualified && newMilestones.length > 0,
  };
}

export function findCandidatePools(receipt, projectAddress, quoteAddresses) {
  const project = normalizeAddr(projectAddress);
  const quotes = new Set((quoteAddresses || []).map(normalizeAddr));
  return (receipt?.logs || [])
    .map(decodeV4InitializeLog)
    .filter(Boolean)
    .filter((pool) => {
      const currencies = new Set([pool.currency0, pool.currency1]);
      return currencies.has(project) && [...quotes].some((quote) => currencies.has(quote));
    });
}
