import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_POOL_ROUTES,
  BASE_VVV,
  TOPIC0_AERODROME_POOL_CREATED,
  TOPIC0_AERODROME_SLIPSTREAM_POOL_CREATED,
  TOPIC0_UNISWAP_V2_PAIR_CREATED,
  TOPIC0_UNISWAP_V3_POOL_CREATED,
  TOPIC0_UNISWAP_V4_INITIALIZE,
  basePoolHistoryRecord,
  buildVvvPoolFilters,
  decodeBasePoolLog,
} from "../src/base.mjs";

const COUNTERPART = "0xb200000000000000000000334e81c5bf698bdc01";
const POOL = "0x4ef0f94370c6b65d385bcd91f05d7c67e7d3fd04";
const POOL_ID = "0x" + "47".repeat(32);
const TX = "0x" + "ab".repeat(32);

function topicAddress(address) {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function dataAddress(address) {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function route(id) {
  return BASE_POOL_ROUTES.find((item) => item.id === id);
}

function logFor(protocol, overrides = {}) {
  return {
    address: protocol.address,
    transactionHash: TX,
    blockNumber: "0x64",
    logIndex: "0x2",
    removed: false,
    ...overrides,
  };
}

test("Base VVV filters target both indexed currency positions", () => {
  const v4Filters = buildVvvPoolFilters(route("uniswap-v4"));
  assert.deepEqual(v4Filters.map((filter) => filter.topics), [
    [TOPIC0_UNISWAP_V4_INITIALIZE, null, topicAddress(BASE_VVV)],
    [TOPIC0_UNISWAP_V4_INITIALIZE, null, null, topicAddress(BASE_VVV)],
  ]);

  const v2Filters = buildVvvPoolFilters(route("uniswap-v2"));
  assert.deepEqual(v2Filters.map((filter) => filter.topics), [
    [TOPIC0_UNISWAP_V2_PAIR_CREATED, topicAddress(BASE_VVV)],
    [TOPIC0_UNISWAP_V2_PAIR_CREATED, null, topicAddress(BASE_VVV)],
  ]);
});

test("decodes a Uniswap V4 VVV pool initialization", () => {
  const protocol = route("uniswap-v4");
  const event = decodeBasePoolLog(protocol, logFor(protocol, {
    topics: [
      TOPIC0_UNISWAP_V4_INITIALIZE,
      POOL_ID,
      topicAddress(BASE_VVV),
      topicAddress(COUNTERPART),
    ],
    data: "0x",
  }));

  assert.equal(event.protocol, "uniswap-v4");
  assert.equal(event.poolId, POOL_ID);
  assert.equal(event.poolAddress, "");
  assert.equal(event.counterpartAddress, COUNTERPART);
  assert.equal(event.key, "uniswap-v4:" + POOL_ID);
});

test("decodes a Uniswap V3 VVV pool creation", () => {
  const protocol = route("uniswap-v3");
  const event = decodeBasePoolLog(protocol, logFor(protocol, {
    topics: [
      TOPIC0_UNISWAP_V3_POOL_CREATED,
      topicAddress(BASE_VVV),
      topicAddress(COUNTERPART),
      "0x" + (10_000).toString(16).padStart(64, "0"),
    ],
    data: "0x" + "c8".padStart(64, "0") + dataAddress(POOL),
  }));

  assert.equal(event.protocol, "uniswap-v3");
  assert.equal(event.fee, 10_000);
  assert.equal(event.poolAddress, POOL);
  assert.equal(event.counterpartAddress, COUNTERPART);
});

test("decodes Uniswap V2 and Aerodrome VVV pool creations", () => {
  const v2 = route("uniswap-v2");
  const v2Event = decodeBasePoolLog(v2, logFor(v2, {
    topics: [
      TOPIC0_UNISWAP_V2_PAIR_CREATED,
      topicAddress(COUNTERPART),
      topicAddress(BASE_VVV),
    ],
    data: "0x" + dataAddress(POOL) + "1".padStart(64, "0"),
  }));
  assert.equal(v2Event.poolAddress, POOL);
  assert.equal(v2Event.counterpartAddress, COUNTERPART);

  const aerodrome = route("aerodrome");
  const aeroEvent = decodeBasePoolLog(aerodrome, logFor(aerodrome, {
    topics: [
      TOPIC0_AERODROME_POOL_CREATED,
      topicAddress(COUNTERPART),
      topicAddress(BASE_VVV),
      "0x" + "1".padStart(64, "0"),
    ],
    data: "0x" + dataAddress(POOL) + "7".padStart(64, "0"),
  }));
  assert.equal(aeroEvent.poolAddress, POOL);
  assert.equal(aeroEvent.stable, true);
});

test("decodes VVV pools from every Aerodrome Slipstream factory", () => {
  const protocol = route("aerodrome-slipstream");
  for (const address of protocol.address) {
    const event = decodeBasePoolLog(protocol, logFor(protocol, {
      address,
      topics: [
        TOPIC0_AERODROME_SLIPSTREAM_POOL_CREATED,
        topicAddress(COUNTERPART),
        topicAddress(BASE_VVV),
        "0x" + "c8".padStart(64, "0"),
      ],
      data: "0x" + dataAddress(POOL),
    }));
    assert.equal(event.protocol, "aerodrome-slipstream");
    assert.equal(event.poolAddress, POOL);
    assert.equal(event.tickSpacing, 200);
    assert.equal(event.counterpartAddress, COUNTERPART);
  }
});

test("rejects pool creation logs that do not contain the official VVV address", () => {
  const protocol = route("uniswap-v2");
  const event = decodeBasePoolLog(protocol, logFor(protocol, {
    topics: [
      TOPIC0_UNISWAP_V2_PAIR_CREATED,
      topicAddress(COUNTERPART),
      topicAddress("0x1111111111111111111111111111111111111111"),
    ],
    data: "0x" + dataAddress(POOL) + "1".padStart(64, "0"),
  }));
  assert.equal(event, null);
});

test("creates a reviewable Base history record with CA and ticker", () => {
  const protocol = route("uniswap-v2");
  const event = decodeBasePoolLog(protocol, logFor(protocol, {
    topics: [
      TOPIC0_UNISWAP_V2_PAIR_CREATED,
      topicAddress(COUNTERPART),
      topicAddress(BASE_VVV),
    ],
    data: "0x" + dataAddress(POOL) + "1".padStart(64, "0"),
  }));
  const record = basePoolHistoryRecord(event, { symbol: "VVVCAT", name: "VVV Cat", decimals: 18 }, "backfill");
  assert.equal(record.type, "base_vvv_pool_created");
  assert.equal(record.counterpartAddress, COUNTERPART);
  assert.equal(record.counterpartSymbol, "VVVCAT");
  assert.equal(record.source, "backfill");
});
