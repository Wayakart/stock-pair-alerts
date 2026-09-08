import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, readJsonFile, writeJsonFile } from "./state.mjs";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_ATTEMPTS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withFileLock(file, task) {
  const lockPath = file + ".lock";
  await fs.mkdir(path.dirname(file), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    try {
      handle = await fs.open(lockPath, "wx");
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockPath);
      } catch (statErr) {
        if (statErr.code !== "ENOENT") throw statErr;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  if (!handle) throw new Error("Timed out acquiring alert cap lock");
  try {
    return await task();
  } finally {
    await handle.close();
    await fs.unlink(lockPath).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

export function createAlertCap({
  statePath,
  historyPath,
  maxAlerts = 10,
  windowMs = 8 * 60 * 60 * 1_000,
  now = () => Date.now(),
} = {}) {
  if (!statePath) throw new Error("Alert cap statePath is required");
  if (!Number.isInteger(maxAlerts) || maxAlerts < 0) throw new Error("Alert cap maxAlerts must be a non-negative integer");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("Alert cap windowMs must be positive");

  return {
    async reserve(details = {}) {
      return withFileLock(statePath, async () => {
        const nowMs = now();
        const cutoff = nowMs - windowMs;
        const state = await readJsonFile(statePath, { alerts: [] });
        const alerts = (state.alerts || []).filter((item) => Number(item.atMs || 0) > cutoff && Number(item.atMs || 0) <= nowMs);
        const allowed = alerts.length < maxAlerts;
        const entry = {
          atMs: nowMs,
          recordedAt: new Date(nowMs).toISOString(),
          allowed,
          ...details,
        };
        if (allowed) alerts.push(entry);
        await writeJsonFile(statePath, { maxAlerts, windowMs, alerts });
        if (historyPath) await appendJsonLine(historyPath, { type: allowed ? "alert_reserved" : "alert_suppressed", ...entry });
        return {
          allowed,
          used: alerts.length,
          remaining: Math.max(0, maxAlerts - alerts.length),
          maxAlerts,
          windowMs,
        };
      });
    },
  };
}
