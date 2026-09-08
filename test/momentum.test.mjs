import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPIC0_UNISWAP_V4_INITIALIZE,
  TOPIC0_UNISWAP_V4_SWAP,
  UNISWAP_V4_POOL_MANAGER,
  aggregateV4Swaps,
  buildV4SwapLogFilter,
  createMomentumCandidate,
  decodeV4InitializeLog,
  estimateFdvUsd,
  findCandidatePools,
  normalizePoolTrade,
  recordCandidateTrade,
} from "../src/momentum.mjs";
import { normalizeAddr } from "../src/lib.mjs";

const project = normalizeAddr("0x1111111111111111111111111111111111111111");
const quote = normalizeAddr("0x2222222222222222222222222222222222222222");
const poolId = "0x" + "a".repeat(64);
const q96 = 1n << 96n;

function word(value) {
  let number = BigInt(value);
  if (number < 0n) number += 1n << 256n;
  return number.toString(16).padStart(64, "0");
}

function addressTopic(address) {
  return "0x" + normalizeAddr(address).slice(2).padStart(64, "0");
}

function swapLog({ amount0, amount1, sqrtPriceX96 = q96, tx = "0xtx", block = 100 }) {
  return {
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPIC0_UNISWAP_V4_SWAP, poolId, addressTopic("0x3333333333333333333333333333333333333333")],
    data: "0x" + [amount0, amount1, sqrtPriceX96, 1n, 0n, 1000n].map(word).join(""),
    transactionHash: tx,
    blockNumber: "0x" + block.toString(16),
  };
}

function candidate({ sqrtPriceX96 = q96 / 128n, projectIndex = 0 } = {}) {
  const pool = {
    poolId,
    currency0: projectIndex === 0 ? project : quote,
    currency1: projectIndex === 0 ? quote : project,
    sqrtPriceX96,
  };
  return createMomentumCandidate({
    pool,
    platform: "Long",
    project: {
      address: project,
      symbol: "TEST",
      name: "Test Token",
      decimals: 18,
      totalSupply: (1_000_000n * 10n ** 18n).toString(),
    },
    quote: { address: quote, symbol: "AMD", decimals: 18, currentMultiplier: 1 },
    launchTx: "0xlaunch",
    launchBlock: 99,
    launchedAtMs: 1_000_000,
  });
}

function buyTrade(index, { timestampMs, block = 101, quoteUsd = 100, sqrtPriceX96 = q96 / 128n } = {}) {
  return {
    tx: "0xbuy" + index,
    buyer: normalizeAddr("0x" + String(index).padStart(40, "0")),
    block,
    timestampMs: timestampMs ?? 1_000_000 + index * 10_000,
    side: "buy",
    projectAmount: 500,
    quoteAmount: 5,
    quoteUsd,
    volumeUsd: quoteUsd === null ? null : quoteUsd * 5,
    sqrtPriceX96: sqrtPriceX96.toString(),
    swapCount: 1,
  };
}

test("decodes Initialize and finds the project/stock pool", () => {
  const log = {
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPIC0_UNISWAP_V4_INITIALIZE, poolId, addressTopic(project), addressTopic(quote)],
    data: "0x" + [0x800000n, 8n, 0x3333333333333333333333333333333333333333n, q96, -100n].map(word).join(""),
    transactionHash: "0xlaunch",
    blockNumber: "0x63",
  };
  const decoded = decodeV4InitializeLog(log);
  assert.equal(decoded.poolId, poolId);
  assert.equal(decoded.currency0, project);
  assert.equal(decoded.currency1, quote);
  assert.equal(decoded.sqrtPriceX96, q96);
  assert.deepEqual(findCandidatePools({ logs: [log] }, project, [quote]), [decoded]);
});

test("builds a PoolManager swap filter scoped to active pool ids", () => {
  const secondPoolId = "0x" + "b".repeat(64);
  assert.equal(buildV4SwapLogFilter([]), null);
  assert.deepEqual(buildV4SwapLogFilter([poolId]), {
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPIC0_UNISWAP_V4_SWAP, poolId],
  });
  assert.deepEqual(buildV4SwapLogFilter([secondPoolId, poolId.toUpperCase(), secondPoolId]), {
    address: UNISWAP_V4_POOL_MANAGER,
    topics: [TOPIC0_UNISWAP_V4_SWAP, [poolId, secondPoolId]],
  });
});

test("aggregates every matching swap log in one transaction and preserves signed deltas", () => {
  const logs = [
    swapLog({ amount0: 100n * 10n ** 18n, amount1: -2n * 10n ** 18n }),
    swapLog({ amount0: 50n * 10n ** 18n, amount1: -3n * 10n ** 18n }),
  ];
  const aggregate = aggregateV4Swaps(logs, poolId);
  assert.equal(aggregate.amount0, 150n * 10n ** 18n);
  assert.equal(aggregate.amount1, -5n * 10n ** 18n);
  assert.equal(aggregate.swapCount, 2);

  const trade = normalizePoolTrade(candidate(), aggregate, {
    buyer: "0x4444444444444444444444444444444444444444",
    timestampMs: 1_010_000,
    quoteUsd: 100,
  });
  assert.equal(trade.side, "buy");
  assert.equal(trade.projectAmount, 150);
  assert.equal(trade.quoteAmount, 5);
  assert.equal(trade.volumeUsd, 500);
});

test("qualifies early momentum and exposes coordinated same-block buys", () => {
  let current = candidate({ sqrtPriceX96: q96 / 128n });
  let result;
  for (let index = 1; index <= 3; index++) {
    result = recordCandidateTrade(current, buyTrade(index, { sqrtPriceX96: q96 / 128n }));
    current = result.candidate;
  }
  assert.equal(result.shouldNotify, true);
  assert.equal(result.metrics.uniqueBuyers, 3);
  assert.equal(result.metrics.buyVolumeUsd, 1500);
  assert.equal(result.metrics.maxSameBlockBuyers, 3);
  assert.ok(result.reasons.includes("early buyer momentum"));
  assert.ok(result.reasons.includes("coordinated same-block buys"));
  assert.deepEqual(result.newMilestones, []);

  const duplicate = recordCandidateTrade(current, buyTrade(3));
  assert.equal(duplicate.duplicate, true);
});

test("does not qualify a dust-driven FDV spike", () => {
  const dust = {
    ...buyTrade(1, { sqrtPriceX96: q96 }),
    quoteAmount: 0.000001,
    volumeUsd: 0.0001,
  };
  const result = recordCandidateTrade(candidate(), dust);
  assert.equal(result.metrics.estimatedFdvUsd, 100_000_000);
  assert.equal(result.shouldNotify, false);
  assert.deepEqual(result.newMilestones, []);
});

test("uses rapid wallet growth when the Robinhood USD quote is temporarily unavailable", () => {
  let current = candidate();
  let result;
  for (let index = 1; index <= 5; index++) {
    result = recordCandidateTrade(current, buyTrade(index, { block: 100 + index, quoteUsd: null }));
    current = result.candidate;
  }
  assert.equal(result.shouldNotify, true);
  assert.equal(result.metrics.buyVolumeUsd, null);
  assert.deepEqual(result.reasons, ["rapid wallet growth; USD quote unavailable"]);
});

test("later FDV milestones update an already-qualified candidate", () => {
  let current = candidate({ sqrtPriceX96: q96 / 128n });
  let result;
  for (let index = 1; index <= 3; index++) {
    result = recordCandidateTrade(current, buyTrade(index, { block: 100 + index }));
    current = result.candidate;
  }
  assert.equal(result.shouldNotify, true);
  assert.deepEqual(result.newMilestones, []);

  result = recordCandidateTrade(current, buyTrade(4, {
    block: 110,
    timestampMs: 1_070_000,
    sqrtPriceX96: q96 / 40n,
  }));
  assert.equal(result.shouldUpdate, true);
  assert.deepEqual(result.newMilestones, [20_000, 50_000]);
});

test("estimates FDV correctly when the project is currency1", () => {
  const inverse = candidate({ sqrtPriceX96: q96 * 2n, projectIndex: 1 });
  assert.equal(estimateFdvUsd(inverse, q96 * 2n, 100), 25_000_000);
});
