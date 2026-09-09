import { hexToBigInt, normalizeAddr } from "./lib.mjs";

export const BASE_CHAIN_ID = 8453;
export const BASE_EXPLORER = "https://basescan.org";
export const BASE_VVV = "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf";

export const BASE_UNISWAP_V4_POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
export const BASE_UNISWAP_V3_FACTORY = "0x33128a8fc17869897dce68ed026d694621f6fdfd";
export const BASE_UNISWAP_V2_FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6";
export const BASE_AERODROME_POOL_FACTORY = "0x420dd381b31aef6683db6b902084cb0ffece40da";
export const BASE_AERODROME_SLIPSTREAM_FACTORIES = [
  "0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a",
  "0xade65c38cd4849adba595a4323a8c7ddfe89716a",
  "0xf8f2eb4940cfe7d13603dddd87f123820fc061ef",
];

export const TOPIC0_UNISWAP_V4_INITIALIZE =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const TOPIC0_UNISWAP_V3_POOL_CREATED =
  "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
export const TOPIC0_UNISWAP_V2_PAIR_CREATED =
  "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const TOPIC0_AERODROME_POOL_CREATED =
  "0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e";
export const TOPIC0_AERODROME_SLIPSTREAM_POOL_CREATED =
  "0xab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2";

function topicAddress(value) {
  return "0x" + normalizeAddr(value).slice(2).padStart(64, "0");
}

function addressFromTopic(value) {
  if (!value) return "";
  return normalizeAddr("0x" + String(value).slice(-40));
}

function dataWord(data, index) {
  const hex = String(data || "0x").replace(/^0x/, "");
  const start = index * 64;
  if (hex.length < start + 64) return "";
  return hex.slice(start, start + 64);
}

function addressFromData(data, index) {
  const word = dataWord(data, index);
  return word ? normalizeAddr("0x" + word.slice(-40)) : "";
}

function numberFromTopic(value) {
  try {
    return Number(hexToBigInt(value));
  } catch {
    return null;
  }
}

function baseFields(log, route) {
  return {
    protocol: route.id,
    venue: route.venue,
    tx: String(log.transactionHash || "").toLowerCase(),
    block: numberFromTopic(log.blockNumber),
    logIndex: numberFromTopic(log.logIndex),
    removed: Boolean(log.removed),
  };
}

function decodeV4(log, route) {
  if ((log.topics || []).length < 4) return null;
  return {
    ...baseFields(log, route),
    token0: addressFromTopic(log.topics[2]),
    token1: addressFromTopic(log.topics[3]),
    poolId: String(log.topics[1] || "").toLowerCase(),
    poolAddress: "",
  };
}

function decodeV3(log, route) {
  if ((log.topics || []).length < 4) return null;
  const poolAddress = addressFromData(log.data, 1);
  if (!poolAddress) return null;
  return {
    ...baseFields(log, route),
    token0: addressFromTopic(log.topics[1]),
    token1: addressFromTopic(log.topics[2]),
    fee: numberFromTopic(log.topics[3]),
    poolId: "",
    poolAddress,
  };
}

function decodeV2(log, route) {
  if ((log.topics || []).length < 3) return null;
  const poolAddress = addressFromData(log.data, 0);
  if (!poolAddress) return null;
  return {
    ...baseFields(log, route),
    token0: addressFromTopic(log.topics[1]),
    token1: addressFromTopic(log.topics[2]),
    poolId: "",
    poolAddress,
  };
}

function decodeAerodrome(log, route) {
  const event = decodeV2(log, route);
  if (!event || (log.topics || []).length < 4) return null;
  return { ...event, stable: hexToBigInt(log.topics[3]) !== 0n };
}

function decodeAerodromeSlipstream(log, route) {
  if ((log.topics || []).length < 4) return null;
  const poolAddress = addressFromData(log.data, 0);
  if (!poolAddress) return null;
  return {
    ...baseFields(log, route),
    token0: addressFromTopic(log.topics[1]),
    token1: addressFromTopic(log.topics[2]),
    tickSpacing: numberFromTopic(log.topics[3]),
    poolId: "",
    poolAddress,
  };
}

export const BASE_POOL_ROUTES = [
  {
    id: "uniswap-v4",
    venue: "Uniswap V4",
    address: BASE_UNISWAP_V4_POOL_MANAGER,
    topic0: TOPIC0_UNISWAP_V4_INITIALIZE,
    tokenTopicIndexes: [2, 3],
    decode: decodeV4,
  },
  {
    id: "uniswap-v3",
    venue: "Uniswap V3",
    address: BASE_UNISWAP_V3_FACTORY,
    topic0: TOPIC0_UNISWAP_V3_POOL_CREATED,
    tokenTopicIndexes: [1, 2],
    decode: decodeV3,
  },
  {
    id: "uniswap-v2",
    venue: "Uniswap V2",
    address: BASE_UNISWAP_V2_FACTORY,
    topic0: TOPIC0_UNISWAP_V2_PAIR_CREATED,
    tokenTopicIndexes: [1, 2],
    decode: decodeV2,
  },
  {
    id: "aerodrome",
    venue: "Aerodrome",
    address: BASE_AERODROME_POOL_FACTORY,
    topic0: TOPIC0_AERODROME_POOL_CREATED,
    tokenTopicIndexes: [1, 2],
    decode: decodeAerodrome,
  },
  {
    id: "aerodrome-slipstream",
    venue: "Aerodrome Slipstream",
    address: BASE_AERODROME_SLIPSTREAM_FACTORIES,
    topic0: TOPIC0_AERODROME_SLIPSTREAM_POOL_CREATED,
    tokenTopicIndexes: [1, 2],
    decode: decodeAerodromeSlipstream,
  },
];

export function buildVvvPoolFilters(route, vvv = BASE_VVV) {
  const target = topicAddress(vvv);
  return route.tokenTopicIndexes.map((index) => {
    const topics = Array(index + 1).fill(null);
    topics[0] = route.topic0;
    topics[index] = target;
    return { address: route.address, topics };
  });
}

export function decodeBasePoolLog(route, log, vvv = BASE_VVV) {
  if (!route || !log) return null;
  const routeAddresses = (Array.isArray(route.address) ? route.address : [route.address]).map(normalizeAddr);
  if (!routeAddresses.includes(normalizeAddr(log.address))) return null;
  if (String(log.topics?.[0] || "").toLowerCase() !== route.topic0) return null;
  const event = route.decode(log, route);
  if (!event) return null;
  const target = normalizeAddr(vvv);
  const token0 = normalizeAddr(event.token0);
  const token1 = normalizeAddr(event.token1);
  if (token0 !== target && token1 !== target) return null;
  if (token0 === token1) return null;
  const counterpartAddress = token0 === target ? token1 : token0;
  const poolKey = event.poolId || event.poolAddress;
  if (!counterpartAddress || !poolKey) return null;
  return {
    ...event,
    chain: "base",
    chainId: BASE_CHAIN_ID,
    vvvAddress: target,
    counterpartAddress,
    key: route.id + ":" + poolKey.toLowerCase(),
  };
}

export function basePoolHistoryRecord(event, metadata = {}, source = "live") {
  return {
    type: event.removed ? "base_vvv_pool_removed" : "base_vvv_pool_created",
    observedAt: new Date().toISOString(),
    source,
    chain: event.chain,
    chainId: event.chainId,
    protocol: event.protocol,
    venue: event.venue,
    key: event.key,
    poolId: event.poolId || null,
    poolAddress: event.poolAddress || null,
    token0: event.token0,
    token1: event.token1,
    vvvAddress: event.vvvAddress,
    counterpartAddress: event.counterpartAddress,
    counterpartSymbol: metadata.symbol || "",
    counterpartName: metadata.name || "",
    counterpartDecimals: metadata.decimals ?? null,
    tx: event.tx,
    block: event.block,
    logIndex: event.logIndex,
    fee: event.fee ?? null,
    stable: event.stable ?? null,
    tickSpacing: event.tickSpacing ?? null,
  };
}
