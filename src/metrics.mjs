const NS_PER_MS = 1_000_000;

function nowNs() {
  return process.hrtime.bigint();
}

export function isoNow() {
  return new Date().toISOString();
}

export function msSince(startNs) {
  return Number(process.hrtime.bigint() - startNs) / NS_PER_MS;
}

export function logJson(event, data = {}) {
  console.log(JSON.stringify({ event, ts: isoNow(), ...data }));
}

export function warnJson(event, data = {}) {
  console.warn(JSON.stringify({ event, ts: isoNow(), ...data }));
}

export function createLatencyTrace({ chain, platform, tx, signature, slot, block }) {
  const startedNs = nowNs();
  const marks = [];
  return {
    mark(name, extra = {}) {
      marks.push({ name, tMs: Number(msSince(startedNs).toFixed(3)), ...extra });
    },
    elapsedMs() {
      return Number(msSince(startedNs).toFixed(3));
    },
    done(outcome, extra = {}) {
      logJson("latency", {
        chain,
        platform,
        tx,
        signature,
        slot,
        block,
        outcome,
        totalMs: Number(msSince(startedNs).toFixed(3)),
        marks,
        ...extra,
      });
    },
  };
}

export function createHeartbeat({ service, intervalMs = 60_000, staleMs = 180_000, onStale } = {}) {
  let startedAt = Date.now();
  let lastEventAt = 0;
  let lastMessageAt = 0;
  let lastHeartbeatAt = 0;
  let lastStaleWarnAt = 0;
  let eventCount = 0;
  let alertCount = 0;
  let errorCount = 0;

  return {
    message() {
      lastMessageAt = Date.now();
    },
    event() {
      eventCount += 1;
      lastEventAt = Date.now();
      lastMessageAt = lastEventAt;
    },
    alert() {
      alertCount += 1;
    },
    error() {
      errorCount += 1;
    },
    async tick({ force = false } = {}) {
      const now = Date.now();
      if (!force && now - lastHeartbeatAt < intervalMs) return;
      lastHeartbeatAt = now;
      const ageMs = lastMessageAt ? now - lastMessageAt : null;
      logJson("heartbeat", {
        service,
        uptimeMs: now - startedAt,
        lastMessageAgeMs: ageMs,
        lastEventAgeMs: lastEventAt ? now - lastEventAt : null,
        eventCount,
        alertCount,
        errorCount,
      });
      if (ageMs !== null && ageMs > staleMs && now - lastStaleWarnAt > staleMs) {
        lastStaleWarnAt = now;
        warnJson("stale_connection", { service, lastMessageAgeMs: ageMs, staleMs });
        if (onStale) await onStale({ service, lastMessageAgeMs: ageMs, staleMs });
      }
    },
  };
}
