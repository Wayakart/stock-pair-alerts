import test from "node:test";
import assert from "node:assert/strict";
import {
  createRhPriceCache,
  requestWithRetry,
  robinhoodQuoteUsd,
} from "../src/rh-price-cache.mjs";

const asset = { symbol: "AMD", currentMultiplier: 2 };

function httpError(status, retryAfterMs = 0) {
  return Object.assign(new Error("HTTP " + status), { status, retryAfterMs });
}

test("computes midpoint stock-token pricing with its multiplier", () => {
  assert.equal(robinhoodQuoteUsd({ bid: "10", ask: "12" }, asset), 22);
  assert.equal(robinhoodQuoteUsd({ bid: "0", ask: "8" }, asset), 16);
  assert.equal(robinhoodQuoteUsd({}, asset), null);
});

test("request retry honors provider retry-after and skips client errors", async () => {
  const delays = [];
  let calls = 0;
  const result = await requestWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw httpError(429, 1_500);
    return "ok";
  }, {
    wait: async (ms) => delays.push(ms),
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_500]);

  calls = 0;
  await assert.rejects(requestWithRetry(async () => {
    calls += 1;
    throw httpError(400);
  }, {
    wait: async () => assert.fail("400 responses must not retry"),
  }), /HTTP 400/);
  assert.equal(calls, 1);
});

test("bulk prime retries a 429 and fills the shared cache", async () => {
  let calls = 0;
  const delays = [];
  const cache = createRhPriceCache({
    pricesUrl: "https://prices/",
    allPricesUrl: "https://prices",
    requestJson: async () => {
      calls += 1;
      if (calls === 1) throw httpError(429, 750);
      return { quotes: [{ tokenSymbol: "AMD", bid: "10", ask: "12" }] };
    },
    wait: async (ms) => delays.push(ms),
  });

  await cache.prime([asset]);
  assert.equal(await cache.get(asset), 22);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [750]);
});

test("returns stale pricing while a failed refresh cools down", async () => {
  let nowMs = 1_000;
  let calls = 0;
  const warnings = [];
  const cache = createRhPriceCache({
    pricesUrl: "https://prices/",
    allPricesUrl: "https://prices",
    requestJson: async (url) => {
      calls += 1;
      if (url === "https://prices") {
        return { quotes: [{ tokenSymbol: "AMD", bid: "10", ask: "12" }] };
      }
      throw httpError(429);
    },
    warn: (event, details) => warnings.push({ event, details }),
    now: () => nowMs,
    wait: async () => {},
    freshMs: 60_000,
    retryCooldownMs: 60_000,
  });

  await cache.prime([asset]);
  nowMs += 60_001;
  assert.equal(await cache.get(asset), 22);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, "rh_price_unavailable");
  assert.equal(calls, 5);

  assert.equal(await cache.get(asset), 22);
  assert.equal(calls, 5);
});
