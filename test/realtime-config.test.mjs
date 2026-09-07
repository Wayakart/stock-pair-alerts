import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Robinhood realtime listener requires explicit production WebSocket", async () => {
  const env = { ...process.env };
  delete env.REALTIME_RPC_WS_URL;
  delete env.RPC_WS_URL;
  delete env.RPC_URL;
  delete env.ALLOW_PUBLIC_ROBINHOOD_RPC;

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /REALTIME_RPC_WS_URL is required/);
      return true;
    }
  );
});

test("Robinhood realtime listener can require QuickNode endpoint", async () => {
  const env = {
    ...process.env,
    REALTIME_RPC_WS_URL: "wss://example.com/not-quicknode",
    REQUIRE_QUICKNODE_ROBINHOOD: "1",
  };
  delete env.RPC_WS_URL;
  delete env.RPC_URL;
  delete env.ALLOW_PUBLIC_ROBINHOOD_RPC;

  await assert.rejects(
    () => execFileAsync(process.execPath, ["src/realtime.mjs"], {
      cwd: new URL("..", import.meta.url),
      env,
      timeout: 5_000,
    }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /must be a QuickNode Robinhood WebSocket URL/);
      return true;
    }
  );
});
