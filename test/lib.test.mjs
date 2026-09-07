import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import {
  TOPIC0_APPROVAL,
  TOPIC0_LAUNCH,
  TOPIC0_FLAP_TOKEN_QUOTE_SET,
  TOPIC0_PAIR_CUSTOM_QUOTE_POOL_CREATED,
  TOPIC0_PAIR_CANONICAL_POOL_LAUNCHED,
  TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED,
  PUMP_CREATE_EVENT_DISCRIMINATOR,
  decodeApprovalLog,
  decodeLaunchLog,
  decodeFlapQuoteSetLog,
  decodePairCustomQuotePoolLog,
  decodePairCanonicalPoolLog,
  decodePairCanonicalProjectLog,
  decodePumpCreateEvent,
  isPumpCreateLog,
  decodeAbiString,
  extractRhAssets,
  applyPonsLogs,
  applyLongLogs,
  applyFlapQuoteLogs,
  applyPairPoolLogs,
  applyPairLaunches,
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
  uniqueWebhookUrls,
  isInterestingAsset,
  isInterestingSolanaAsset,
  PUMP_PROGRAM,
  redactUrl,
  buildDiscordAlertPayload,
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

test("Long alerts every distinct launch even when the stock repeats", () => {
  const nv = normalizeAddr(nvda);
  const ap = normalizeAddr(aapl);
  const r = applyLongLogs(
    { longLaunches: ["0x1"], longNumeraires: [nv], longLastBlock: 10 },
    [
      { numeraire: nv, tx: "0x1", block: 11 },
      { numeraire: ap, tx: "0x2", block: 12 },
      { numeraire: ap, tx: "0x2", block: 12 },
      { numeraire: ap, tx: "0x3", block: 13 },
    ],
    { rhMap, allowAlerts: true }
  );
  assert.equal(r.alerts.length, 2);
  assert.equal(r.alerts[0].numeraire, ap);
  assert.ok(r.longNumeraires.includes(ap));
  assert.deepEqual(r.longLaunches, ["0x1", "0x2", "0x3"]);
});

test("decode Pair Fund project launch from the current coordinator", () => {
  const project = "0x7eedbb9174b4b1b203f27f8d6a270743039f5555";
  const creator = "0x129f3e63aa27f340346ebf1ae75f354c87745ce0";
  const vault = "0x05ced8494d968a0566c7e1359b7b22afb647b37f";
  const event = decodePairCanonicalProjectLog({
    topics: [
      TOPIC0_PAIR_CANONICAL_PROJECT_LAUNCHED,
      "0x000000000000000000000000" + project.slice(2),
      "0x000000000000000000000000" + creator.slice(2),
      "0x000000000000000000000000" + vault.slice(2),
    ],
    transactionHash: "0xpairlaunch",
    blockNumber: "0x35f888f",
  });
  assert.equal(event.project, project);
  assert.equal(event.creator, creator);
  assert.equal(event.tx, "0xpairlaunch");
});

test("decode Pair Fund canonical pool quote and pool id", () => {
  const project = "0x7eedbb9174b4b1b203f27f8d6a270743039f5555";
  const vault = "0x05ced8494d968a0566c7e1359b7b22afb647b37f";
  const poolId = "0x" + "a".repeat(64);
  const event = decodePairCanonicalPoolLog({
    topics: [
      TOPIC0_PAIR_CANONICAL_POOL_LAUNCHED,
      "0x000000000000000000000000" + project.slice(2),
      "0x000000000000000000000000" + vault.slice(2),
      "0x000000000000000000000000" + nvda.slice(2).toLowerCase(),
    ],
    data: poolId + "0".repeat(64 * 4),
    transactionHash: "0xpairlaunch",
    blockNumber: "0x35f888f",
  });
  assert.equal(event.project, project);
  assert.equal(event.quote, normalizeAddr(nvda));
  assert.equal(event.poolId, poolId);
});

test("Pair Fund deduplicates one project alert per launch transaction", () => {
  const event = {
    project: "0x7eedbb9174b4b1b203f27f8d6a270743039f5555",
    tx: "0xpairlaunch",
    block: 42,
  };
  const result = applyPairLaunches({ pairLaunches: [], pairLastBlock: 0 }, [event, event], { allowAlerts: true });
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(result.pairLaunches, ["0xpairlaunch"]);
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
  assert.equal(event.mint, "newMint");
  assert.equal(event.quoteMint, nvdax);
  assert.equal(event.signature, "solsig");
  assert.equal(event.slot, 123);
});

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function borshString(value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
}

test("Pump CreateV2 CreateEvent decodes project ticker, mint, and quote mint directly", () => {
  const mint = "So11111111111111111111111111111111111111112";
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const bytes = Buffer.concat([
    PUMP_CREATE_EVENT_DISCRIMINATOR,
    borshString("Stock Rocket"),
    borshString("ROCKET"),
    borshString("https://example.com/meta.json"),
    bs58.decode(mint),
    bs58.decode(nvdax),
    bs58.decode(mint),
    bs58.decode(nvdax),
    u64(123),
    u64(1),
    u64(2),
    u64(3),
    u64(4),
    bs58.decode(tokenProgram),
    Buffer.from([0, 1]),
    bs58.decode(nvdax),
    u64(5),
  ]);
  const event = decodePumpCreateEvent([
    "Program log: Instruction: CreateV2",
    "Program data: " + bytes.toString("base64"),
  ]);
  assert.equal(event.name, "Stock Rocket");
  assert.equal(event.symbol, "ROCKET");
  assert.equal(event.mint, mint);
  assert.equal(event.quoteMint, nvdax);
  assert.equal(event.isCashbackEnabled, true);
  assert.equal(isPumpCreateLog(["Program log: Instruction: CreateV2"]), true);
  assert.equal(isPumpCreateLog(["Program log: Instruction: Buy"]), false);
});

test("ABI string decoder handles dynamic ERC20 metadata", () => {
  const text = Buffer.from("AIRE");
  const encoded = Buffer.concat([
    Buffer.alloc(31), Buffer.from([32]),
    Buffer.alloc(31), Buffer.from([text.length]),
    text, Buffer.alloc(32 - text.length),
  ]);
  assert.equal(decodeAbiString("0x" + encoded.toString("hex")), "AIRE");
});

test("Discord alert displays the project CA and keeps Rick automation opt-in", () => {
  const project = "0x7eedbb9174b4b1b203f27f8d6a270743039f5555";
  const alert = {
    chain: "robinhood",
    platform: "Pair",
    projectAddress: project,
    projectSymbol: "AIRE",
    projectName: "AI RESERVE",
    quotes: [{ address: normalizeAddr(nvda), symbol: "NVDA" }],
    tx: "0x1234567890",
    signal: {
      reasons: ["early buyer momentum"],
      uniqueBuyers: 4,
      buyVolumeUsd: 2500,
      ageSeconds: 18.5,
      estimatedFdvUsd: 50000,
      maxSameBlockBuyers: 3,
      bundleSupplyPercent: 1.25,
      topBuyerSharePercent: 40,
      milestones: [20000, 50000],
    },
  };
  const manual = buildDiscordAlertPayload(alert);
  assert.equal(manual.content, undefined);
  assert.match(manual.embeds[0].title, /\$AIRE/);
  assert.equal(manual.embeds[0].fields[2].value, "`" + project + "`");
  assert.match(manual.embeds[0].fields.find((field) => field.name === "Paired with").value, /NVDA/);
  assert.equal(manual.embeds[0].fields.find((field) => field.name === "Unique buyers").value, "4");
  assert.equal(manual.embeds[0].fields.find((field) => field.name === "Buy volume").value, "$2,500");

  const automatic = buildDiscordAlertPayload(alert, { rickAutoScan: true });
  assert.equal(automatic.content, ".x " + project);
});

test("Solana alerts use Rick's pump scan command", () => {
  const payload = buildDiscordAlertPayload({
    chain: "solana",
    platform: "Pump.fun",
    projectAddress: nvdax,
    projectSymbol: "NVDAXPAIR",
    quotes: [],
  }, { rickAutoScan: true });
  assert.equal(payload.content, ".pf " + nvdax);
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
      currentMultiplier: "1.125000000000000000",
      tokenDecimals: 18,
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ contractAddress: nvda, chainId: 4663 }],
    }],
  });
  assert.equal(next[normalizeAddr(nvda)].symbol, "NVDA");
  assert.equal(next[normalizeAddr(nvda)].currentMultiplier, 1.125);
  assert.equal(next[normalizeAddr(nvda)].decimals, 18);
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

test("uniqueWebhookUrls removes duplicate Discord destinations", () => {
  assert.deepEqual(uniqueWebhookUrls([
    "https://discord.com/api/webhooks/1/token/",
    " https://discord.com/api/webhooks/1/token ",
    "http://discord.com/api/webhooks/2/token",
    "",
  ]), ["https://discord.com/api/webhooks/1/token"]);
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
