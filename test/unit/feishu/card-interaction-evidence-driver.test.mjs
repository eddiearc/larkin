import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRIVER = path.join(ROOT, "test", "live", "card-interaction-evidence-driver.mjs");

test("live evidence confirmation requires explicit Owner-observed Toast and processing text", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-card-evidence-driver-"));
  try {
    const draftFile = path.join(temp, "draft.json");
    const evidenceFile = path.join(temp, "evidence.json");
    fs.writeFileSync(draftFile, JSON.stringify({
      instance_id: "int_fixture",
      real_click_source: "durable-host-run-awaiting-ui-confirmation",
    }), { mode: 0o600 });
    const baseEnv = {
      ...process.env,
      LARKIN_FEISHU_CARD_TEST_DRAFT_EVIDENCE_FILE: draftFile,
      LARKIN_FEISHU_CARD_TEST_PLATFORM_EVIDENCE_FILE: evidenceFile,
    };
    const missing = spawnSync(process.execPath, [DRIVER, "confirm"], { env: baseEnv, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.equal(fs.existsSync(evidenceFile), false, "blind confirmation must not publish evidence");

    const confirmed = spawnSync(process.execPath, [DRIVER, "confirm"], {
      env: {
        ...baseEnv,
        LARKIN_FEISHU_CARD_TEST_UI_TOAST_TEXT: "已受理，Agent 正在处理，完成后会更新卡片。",
        LARKIN_FEISHU_CARD_TEST_UI_PROCESSING_TEXT: "处理中；当前状态不代表业务已经完成。",
      },
      encoding: "utf8",
    });
    assert.equal(confirmed.status, 0, confirmed.stderr);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    assert.equal(evidence.real_click_source, "owner-confirmed-feishu-ui+durable-host-run");
    assert.deepEqual(evidence.ui_observer.source, "owner-live-ui-confirmation");
    assert.match(evidence.ui_observer.toast_text, /已受理/);
    assert.match(evidence.ui_observer.processing_text, /当前状态不代表业务已经完成/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
