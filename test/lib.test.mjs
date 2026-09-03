import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPIC0_APPROVAL,
  TOPIC0_LAUNCH,
  decodeApprovalLog,
  decodeLaunchLog,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  isStockNumeraire,
  normalizeAddr,
  USDG,
  WETH,
  ZERO,
  logsRpcUrl,
  parseMaxBlockRange,
  shrinkLogChunk,
  growLogChunk,
  DEFAULT_RPC,
  extractO1Quotes,
  applyO1Quotes,
} from "../src/lib.mjs";

const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const aapl = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";

const rhMap = {
  [normalizeAddr(nvda)]: { symbol: "NVDA", address: normalizeAddr(nvda) },
  [normalizeAddr(aapl)]: { symbol: "AAPL", address: normalizeAddr(aapl) },
};

test("decode PairTokenApprovalUpdated", () => {
  const e = decodeApprovalLog({
    topics: [TOPIC0_APPROVAL, "0x000000000000000000000000" + nvda.slice(2).toLowerCase()],
    data: "0x" + "0".repeat(63) + "1",
    transactionHash: "0xabc",
    blockNumber: "0x10",
  });
  assert.equal(e.pairToken, normalizeAddr(nvda));
  assert.equal(e.approved, true);
  assert.equal(e.block, 16);
});

test("first Pons run is silent", () => {
  const r = applyPonsLogs(
    { initialized: false, ponsApproved: [], ponsLastBlock: 0 },
    [{ pairToken: normalizeAddr(nvda), approved: true, tx: "0x1", block: 10 }]
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.ponsApproved.length, 1);
});

test("later Pons run alerts new approvals", () => {
  const addr = normalizeAddr(nvda);
  const r = applyPonsLogs(
    { initialized: true, ponsApproved: [addr], ponsLastBlock: 10 },
    [
      { pairToken: addr, approved: true, tx: "0x1", block: 11 },
      { pairToken: "0x1111111111111111111111111111111111111111", approved: true, tx: "0x2", block: 12 },
    ]
  );
  assert.equal(r.alerts.length, 1);
});

test("decode LaunchCreated numeraire", () => {
  const e = decodeLaunchLog({
    topics: [
      TOPIC0_LAUNCH,
      "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0x000000000000000000000000" + nvda.slice(2).toLowerCase(),
    ],
    transactionHash: "0xdef",
    blockNumber: "0x20",
  });
  assert.equal(e.numeraire, normalizeAddr(nvda));
  assert.equal(e.block, 32);
});

test("Long backfill is silent then remembers numeraires", () => {
  const r = applyLongLogs(
    { longNumeraires: [], longLastBlock: 0 },
    [
      { numeraire: normalizeAddr(nvda), tx: "0x1", block: 10 },
      { numeraire: normalizeAddr(aapl), tx: "0x2", block: 11 },
    ],
    { rhMap, allowAlerts: false }
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.longNumeraires.length, 2);
});

test("Long alerts first new stock numeraire once", () => {
  const nv = normalizeAddr(nvda);
  const ap = normalizeAddr(aapl);
  const r = applyLongLogs(
    { longNumeraires: [nv], longLastBlock: 10 },
    [
      { numeraire: nv, tx: "0x1", block: 11 },
      { numeraire: ap, tx: "0x2", block: 12 },
      { numeraire: ap, tx: "0x3", block: 13 },
    ],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].numeraire, ap);
  assert.ok(r.longNumeraires.includes(ap));
});

test("Long does not alert USDG WETH zero or unknown tokens", () => {
  const r = applyLongLogs(
    { longNumeraires: [], longLastBlock: 0 },
    [
      { numeraire: USDG, tx: "0x1", block: 1 },
      { numeraire: WETH, tx: "0x2", block: 2 },
      { numeraire: ZERO, tx: "0x3", block: 3 },
      { numeraire: "0x1111111111111111111111111111111111111111", tx: "0x4", block: 4 },
    ],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.longNumeraires.length, 4);
});

test("isStockNumeraire uses RH catalog lookup", () => {
  assert.equal(isStockNumeraire(nvda, rhMap), true);
  assert.equal(isStockNumeraire(USDG, rhMap), false);
  const next = extractRhAssets({
    assets: [{
      tokenSymbol: "NVDA",
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ contractAddress: nvda, chainId: 4663 }],
    }],
  });
  assert.equal(next[normalizeAddr(nvda)].symbol, "NVDA");
});

test("Alchemy free-tier cap is parsed and does not bounce back above 10", () => {
  const cap = parseMaxBlockRange(new Error("Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range."));
  assert.equal(cap, 10n);
  let size = 14n;
  let maxSize = 2000n;
  maxSize = cap;
  if (size > maxSize) size = maxSize;
  assert.equal(size, 10n);
  const shrunk = shrinkLogChunk(14n, 10n);
  assert.equal(shrunk.size, 7n);
  assert.equal(shrunk.maxSize, 10n);
  assert.equal(growLogChunk(shrunk.size, shrunk.maxSize), 10n);
  assert.equal(growLogChunk(10n, 10n), 10n);
});

test("logsRpcUrl skips Alchemy for getLogs", () => {
  assert.equal(logsRpcUrl("https://robinhood-mainnet.g.alchemy.com/v2/KEY", DEFAULT_RPC), DEFAULT_RPC);
  assert.equal(logsRpcUrl(DEFAULT_RPC, DEFAULT_RPC), DEFAULT_RPC);
});

test("o1 first snapshot is silent", () => {
  const quotes = extractO1Quotes({
    quotes: [
      { address: nvda, symbol: "NVDA", name: "NVIDIA" },
      { address: aapl, symbol: "AAPL", name: "Apple" },
    ],
  });
  const r = applyO1Quotes({ o1Quotes: [] }, quotes);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.o1Quotes.length, 2);
});

test("o1 later run alerts new quote stocks", () => {
  const r = applyO1Quotes(
    { o1Quotes: [normalizeAddr(nvda)] },
    extractO1Quotes({
      quotes: [
        { address: nvda, symbol: "NVDA", name: "NVIDIA" },
        { address: aapl, symbol: "AAPL", name: "Apple" },
      ],
    })
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].symbol, "AAPL");
});

test("o1 extract skips zero USDG WETH", () => {
  const quotes = extractO1Quotes({
    quotes: [
      { address: ZERO, symbol: "ETH" },
      { address: USDG, symbol: "USDG" },
      { address: WETH, symbol: "WETH" },
      { address: nvda, symbol: "NVDA", name: "NVIDIA" },
    ],
  });
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, "NVDA");
});
