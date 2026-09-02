import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPIC0_APPROVAL,
  decodeApprovalLog,
  extractRhAssets,
  diffRhAssets,
  applyPonsLogs,
  normalizeAddr,
} from "../src/lib.mjs";

const nvda = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

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

test("first run is silent", () => {
  const r = applyPonsLogs(
    { initialized: false, ponsApproved: [], ponsLastBlock: 0 },
    [{ pairToken: normalizeAddr(nvda), approved: true, tx: "0x1", block: 10 }]
  );
  assert.equal(r.alerts.length, 0);
});

test("later run alerts new approvals", () => {
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

test("rh catalog diff", () => {
  const next = extractRhAssets({
    assets: [
      {
        tokenSymbol: "NVDA",
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ contractAddress: nvda, chainId: 4663 }],
      },
      {
        tokenSymbol: "NEW",
        status: "ASSET_STATUS_ACTIVE",
        deployments: [{ contractAddress: "0x2222222222222222222222222222222222222222", chainId: 4663 }],
      },
    ],
  });
  const added = diffRhAssets({ [normalizeAddr(nvda)]: { symbol: "NVDA" } }, next);
  assert.equal(added[0].symbol, "NEW");
});
