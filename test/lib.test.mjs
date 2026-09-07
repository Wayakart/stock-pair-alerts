import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPIC0_APPROVAL,
  TOPIC0_LAUNCH,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED,
  decodeApprovalLog,
  decodeLaunchLog,
  decodeFlapQuoteSetLog,
  decodePairCustomQuotePoolLog,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  applyFlapQuoteLogs,
  applyPairPoolLogs,
  extractStonkfunStockPairs,
  findPumpStockLaunch,
  applyPumpStockLaunches,
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
  csvSet,
  isInterestingAsset,
  isInterestingSolanaAsset,
  PUMP_PROGRAM,
  redactUrl,
} from "../src/lib.mjs";

const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const aapl = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const nvdax = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

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

test("decode Flap TokenQuoteSet token and quote", () => {
  const token = "0x3103298cb58d8c28c0841ca73c19be8d0fd57777";
  const e = decodeFlapQuoteSetLog({
    topics: [TOPIC0_FLAP_TOKEN_QUOTE_SET],
    data: "0x" +
      "000000000000000000000000" + token.slice(2).toLowerCase() +
      "000000000000000000000000" + nvda.slice(2).toLowerCase(),
    transactionHash: "0xflap",
    blockNumber: "0x30",
  });
  assert.equal(e.token, normalizeAddr(token));
  assert.equal(e.quote, normalizeAddr(nvda));
  assert.equal(e.block, 48);
});

test("decode Pair Fund CustomQuotePoolCreated project and quote", () => {
  const project = "0x9a4b94ac36433b0fdefea6ebbabb1ced7e4a5555";
  const poolId = "0x" + "a".repeat(64);
  const e = decodePairCustomQuotePoolLog({
    topics: [
      TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED,
      "0x000000000000000000000000" + project.slice(2).toLowerCase(),
      "0x000000000000000000000000" + nvda.slice(2).toLowerCase(),
      poolId,
    ],
    transactionHash: "0xpair",
    blockNumber: "0x40",
  });
  assert.equal(e.project, normalizeAddr(project));
  assert.equal(e.quote, normalizeAddr(nvda));
  assert.equal(e.poolId, poolId);
  assert.equal(e.block, 64);
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

test("Flap alerts new Robinhood stock quote pairs once", () => {
  const token = "0x3103298cb58d8c28c0841ca73c19be8d0fd57777";
  const nv = normalizeAddr(nvda);
  const r = applyFlapQuoteLogs(
    { flapPairs: [], flapLastBlock: 0 },
    [
      { token, quote: nv, tx: "0x1", block: 10 },
      { token, quote: nv, tx: "0x2", block: 11 },
    ],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].quote, nv);
  assert.equal(r.flapPairs.length, 1);
  assert.equal(r.flapLastBlock, 11);
});

test("Flap ignores non-stock quote assets", () => {
  const r = applyFlapQuoteLogs(
    { flapPairs: [], flapLastBlock: 0 },
    [{ token: "0x3103298cb58d8c28c0841ca73c19be8d0fd57777", quote: WETH, tx: "0x1", block: 10 }],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.flapPairs.length, 1);
});

test("Pair Fund alerts new Robinhood stock quote pools once", () => {
  const project = "0x9a4b94ac36433b0fdefea6ebbabb1ced7e4a5555";
  const poolId = "0x" + "b".repeat(64);
  const nv = normalizeAddr(nvda);
  const r = applyPairPoolLogs(
    { pairPools: [], pairLastBlock: 0 },
    [
      { project, quote: nv, poolId, tx: "0x1", block: 10 },
      { project, quote: nv, poolId, tx: "0x2", block: 11 },
    ],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].quote, nv);
  assert.equal(r.pairPools.length, 1);
  assert.equal(r.pairLastBlock, 11);
});

test("Pair Fund ignores non-stock quote assets", () => {
  const r = applyPairPoolLogs(
    { pairPools: [], pairLastBlock: 0 },
    [{
      project: "0x9a4b94ac36433b0fdefea6ebbabb1ced7e4a5555",
      quote: WETH,
      poolId: "0x" + "c".repeat(64),
      tx: "0x1",
      block: 10,
    }],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 0);
  assert.equal(r.pairPools.length, 1);
});

test("StonkFun stock pair extraction keeps Solana stock categories", () => {
  const pairs = extractStonkfunStockPairs({
    data: {
      pairs: [
        { mint: nvdax, symbol: "NVDAX", name: "NVIDIA", category: "xstock" },
        { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", category: "solana" },
      ],
    },
  });
  assert.equal(pairs[nvdax].symbol, "NVDAX");
  assert.equal(Object.keys(pairs).length, 1);
});

test("Pump stock launch finder matches stock quote mints in create transactions", () => {
  const tx = {
    slot: 123,
    transaction: {
      signatures: ["solsig"],
      message: {
        accountKeys: [{ pubkey: "creator" }],
        instructions: [{
          programId: PUMP_PROGRAM,
          accounts: ["newMint", nvdax],
        }],
      },
    },
    meta: { innerInstructions: [] },
  };
  const event = findPumpStockLaunch(tx, { [nvdax]: { symbol: "NVDAX" } });
  assert.equal(event.quoteMint, nvdax);
  assert.equal(event.signature, "solsig");
  assert.equal(event.slot, 123);
});

test("Pump stock launches alert once", () => {
  const event = { quoteMint: nvdax, signature: "solsig", slot: 123 };
  const r = applyPumpStockLaunches(
    { pumpStockLaunches: ["older"] },
    [event, event],
    { stockMap: { [nvdax]: { symbol: "NVDAX" } }, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 1);
  assert.deepEqual(r.pumpStockLaunches, ["older", "solsig"]);
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

test("csvSet normalizes comma-separated values", () => {
  assert.deepEqual([...csvSet(" NVDA, tsla ,, ")], ["nvda", "tsla"]);
  assert.deepEqual([...csvSet(" nvda, tsla ", { normalize: (v) => v.toUpperCase() })], ["NVDA", "TSLA"]);
});

test("isInterestingAsset supports symbol and address allowlists", () => {
  assert.equal(isInterestingAsset({ address: nvda, symbol: "NVDA" }), true);
  assert.equal(isInterestingAsset(
    { address: nvda, symbol: "NVDA" },
    { includeSymbols: new Set(["TSLA"]), includeAddresses: new Set([normalizeAddr(aapl)]) }
  ), false);
  assert.equal(isInterestingAsset(
    { address: nvda, symbol: "NVDA" },
    { includeSymbols: new Set(["NVDA"]) }
  ), true);
  assert.equal(isInterestingAsset(
    { address: nvda, symbol: "NVDA" },
    { includeAddresses: new Set([normalizeAddr(nvda)]) }
  ), true);
});

test("isInterestingAsset exclude lists override broad alerts", () => {
  assert.equal(isInterestingAsset(
    { address: nvda, symbol: "NVDA" },
    { excludeSymbols: new Set(["NVDA"]) }
  ), false);
  assert.equal(isInterestingAsset(
    { address: nvda, symbol: "NVDA" },
    { includeSymbols: new Set(["NVDA"]), excludeAddresses: new Set([normalizeAddr(nvda)]) }
  ), false);
});

test("isInterestingSolanaAsset preserves case-sensitive mint allowlists", () => {
  assert.equal(isInterestingSolanaAsset(
    { address: nvdax, symbol: "NVDAX" },
    { includeAddresses: new Set([nvdax]) }
  ), true);
  assert.equal(isInterestingSolanaAsset(
    { address: nvdax, symbol: "NVDAX" },
    { includeAddresses: new Set([nvdax.toLowerCase()]) }
  ), false);
});

test("redactUrl hides provider tokens in logs", () => {
  assert.equal(
    redactUrl("wss://example.robinhood-mainnet.quiknode.pro/secret-token/"),
    "wss://example.robinhood-mainnet.quiknode.pro/REDACTED/"
  );
  assert.equal(
    redactUrl("https://mainnet.helius-rpc.com/?api-key=secret-token"),
    "https://mainnet.helius-rpc.com/?api-key=REDACTED"
  );
});
