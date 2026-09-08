const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canRetry(err) {
  const status = Number(err?.status || 0);
  return !status || status === 429 || status >= 500;
}

export function robinhoodQuoteUsd(quote, asset) {
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const rawPrice = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
  const multiplier = Number(asset?.currentMultiplier || 1);
  const value = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice * multiplier : null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function requestWithRetry(request, {
  attempts = 4,
  baseDelayMs = 500,
  maxDelayMs = 8_000,
  wait = sleep,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await request();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !canRetry(err)) throw err;
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await wait(Math.max(backoffMs, Number(err?.retryAfterMs || 0)));
    }
  }
  throw lastError;
}

export function createRhPriceCache({
  requestJson,
  pricesUrl,
  allPricesUrl,
  warn = () => {},
  now = Date.now,
  wait = sleep,
  freshMs = 60_000,
  retryCooldownMs = 60_000,
  retryAttempts = 4,
} = {}) {
  if (typeof requestJson !== "function") throw new Error("requestJson is required");
  const values = new Map();
  const retryAfter = new Map();
  const pending = new Map();
  let primePending = null;
  let primeRetryAfter = 0;

  async function refresh(asset) {
    const symbol = String(asset?.symbol || "").toUpperCase();
    try {
      const payload = await requestWithRetry(
        () => requestJson(pricesUrl + encodeURIComponent(symbol)),
        { attempts: retryAttempts, wait }
      );
      const quote = payload?.quotes?.[0] || payload?.quote || payload;
      const value = robinhoodQuoteUsd(quote, asset);
      if (value !== null) values.set(symbol, { value, fetchedAt: now() });
      retryAfter.delete(symbol);
      return value ?? values.get(symbol)?.value ?? null;
    } catch (err) {
      retryAfter.set(symbol, now() + retryCooldownMs);
      warn("rh_price_unavailable", { symbol, error: err.message });
      return values.get(symbol)?.value ?? null;
    } finally {
      pending.delete(symbol);
    }
  }

  async function runPrime(assets) {
    try {
      const bySymbol = new Map((assets || []).map((asset) => [String(asset.symbol || "").toUpperCase(), asset]));
      const payload = await requestWithRetry(() => requestJson(allPricesUrl), {
        attempts: retryAttempts,
        wait,
      });
      const fetchedAt = now();
      for (const quote of payload?.quotes || []) {
        const symbol = String(quote.tokenSymbol || quote.symbol || "").toUpperCase();
        const asset = bySymbol.get(symbol);
        if (!asset) continue;
        const value = robinhoodQuoteUsd(quote, asset);
        if (value !== null) values.set(symbol, { value, fetchedAt });
      }
      primeRetryAfter = 0;
    } catch (err) {
      primeRetryAfter = now() + retryCooldownMs;
      warn("rh_price_prime_unavailable", { error: err.message });
    } finally {
      primePending = null;
    }
  }

  return {
    async get(asset) {
      const symbol = String(asset?.symbol || "").toUpperCase();
      if (!symbol) return null;
      const cached = values.get(symbol);
      if (cached && now() - cached.fetchedAt < freshMs) return cached.value;
      if (primePending || now() < (retryAfter.get(symbol) || 0)) return cached?.value ?? null;
      if (!pending.has(symbol)) pending.set(symbol, refresh(asset));
      return cached?.value ?? null;
    },
    async prime(assets, { force = false } = {}) {
      if (primePending) return primePending;
      if (!force && now() < primeRetryAfter) return null;
      primePending = runPrime(assets);
      return primePending;
    },
  };
}
