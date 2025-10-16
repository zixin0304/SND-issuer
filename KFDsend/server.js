// server_kfd_minter.js
require("dotenv").config();
const express = require("express");
const xrpl = require("xrpl");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const path = require("path");

// 可選：XUMM，一鍵建立信任線
let xumm = null;
try {
  const { XummSdk } = require("xumm-sdk");
  const XUMM_API_KEY    = process.env.XUMM_API_KEY;
  const XUMM_API_SECRET = process.env.XUMM_API_SECRET;
  if (XUMM_API_KEY && XUMM_API_SECRET) {
    xumm = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET);
    console.log("✅ XUMM SDK 已啟用");
  } else {
    console.warn("⚠️ 未設定 XUMM_API_KEY / XUMM_API_SECRET，XUMM 相關 API 將停用");
  }
} catch {
  console.warn("⚠️ 未安裝 xumm-sdk（npm i xumm-sdk），XUMM 相關 API 將停用");
}

const app = express();

// ==== 中介層 ====
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, max: 60 }));

// ── 靜態檔與首頁（可選）─────────────────────────────
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "kfd_admin.html")); // 若沒有此檔，可改成回傳 JSON
});

// ==== 環境變數 ====
const XRPL_ENDPOINT   = process.env.XRPL_ENDPOINT || "wss://s.altnet.rippletest.net:51233";
const ISSUER_SECRET   = process.env.ISSUER_SECRET;
const ISSUER_ADDRESS  = process.env.ISSUER_ADDRESS;
const CURRENCY_CODE   = process.env.CURRENCY_CODE || "KFD";
const MAX_BATCH_ITEMS = Number(process.env.MAX_BATCH_ITEMS || 200);
const MAX_AMOUNT      = Number(process.env.MAX_AMOUNT      || 1_000_000);

if (!ISSUER_SECRET || !ISSUER_ADDRESS) {
  console.error("❌ .env 缺少 ISSUER_SECRET 或 ISSUER_ADDRESS");
  process.exit(1);
}

// ==== XRPL 連線與錢包 ====
const wallet = xrpl.Wallet.fromSeed(ISSUER_SECRET);

// 啟動時強制比對：ISSUER_SECRET 導出的地址應等於 ISSUER_ADDRESS
(function assertIssuerMatchesEnv() {
  const actual = wallet.classicAddress;
  if (actual !== ISSUER_ADDRESS) {
    console.error(`❌ ISSUER_ADDRESS(${ISSUER_ADDRESS}) 與 ISSUER_SECRET 推導地址(${actual}) 不一致`);
    process.exit(1);
  }
})();

function isClassicAddress(addr) {
  try { return xrpl.isValidClassicAddress(addr); } catch { return false; }
}

let client;
async function getClient() {
  if (client && client.isConnected()) return client;
  client = new xrpl.Client(XRPL_ENDPOINT);
  await client.connect();
  return client;
}

// 送出前檢查：對方是否已有 issuer 的 CURRENCY_CODE 信任線（且額度足夠）
async function ensureTrustline(to, needAmountStr) {
  const c = await getClient();
  const lines = await c.request({ command: "account_lines", account: to });
  const line = (lines.result.lines || []).find(
    l => l.currency === CURRENCY_CODE && l.account === wallet.classicAddress
  );
  if (!line) {
    throw new Error(`收款方尚未對 ${wallet.classicAddress} 建立 ${CURRENCY_CODE} 信任線`);
  }
  // 可選：檢查額度
  const limit = Number(line.limit);
  const need = Number(needAmountStr);
  if (Number.isFinite(limit) && Number.isFinite(need) && limit < need) {
    throw new Error(`收款方信任線額度不足（limit=${line.limit} < need=${needAmountStr}）`);
  }
}

// 限制 IOU value 的有效數字長度（<=16）
function assertIouPrecision(valueStr) {
  const plain = valueStr.replace(".", "").replace(/^0+/, "");
  if (plain.length > 16) throw new Error("IOU 數值超過 16 位有效數字限制");
}

// 發送一筆「發行者→用戶」的 IOU（需對方已 TrustSet）
async function sendIOU(to, amountStr) {
  const c = await getClient();

  assertIouPrecision(amountStr);
  await ensureTrustline(to, amountStr); // 先檢查信任線，避免 tecPATH_DRY

  const tx = {
    TransactionType: "Payment",
    Account: wallet.classicAddress,
    Destination: to,
    Amount: {
      currency: CURRENCY_CODE,
      issuer:   wallet.classicAddress,
      value:    amountStr
    }
    // 不要填 Paths / SendMax
  };

  try {
    const prepared = await c.autofill(tx);
    const signed   = wallet.sign(prepared);
    const resp     = await c.submitAndWait(signed.tx_blob);

    const meta = resp.result.meta;
    const code = meta?.TransactionResult || resp.result.engine_result; // 雙保險
    if (code !== "tesSUCCESS") {
      const msg = resp.result.engine_result_message || "未知錯誤";
      throw new Error(`XRPL 付款失敗：${code} - ${msg}`);
    }
    return {
      hash: resp.result.tx_json.hash,
      ledger_index: resp.result.validated_ledger_index ?? resp.result.tx_json?.ledger_index
    };
  } catch (err) {
    // 補充底層引擎錯誤資訊（若有）
    if (err?.data?.engine_result) {
      throw new Error(`XRPL 付款失敗：${err.data.engine_result} - ${err.data.engine_result_message || ""}`);
    }
    throw err;
  }
}

// ==== API ====

// 健康檢查
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    issuer: wallet.classicAddress,
    currency: CURRENCY_CODE,
    endpoint: XRPL_ENDPOINT,
    xummEnabled: !!xumm
  });
});

// 查詢某地址是否已對發行商建立信任線
app.get("/api/check-trustline", async (req, res) => {
  try {
    const to = req.query.to;
    if (!isClassicAddress(to)) throw new Error("接收地址格式錯誤");
    const c = await getClient();
    const lines = await c.request({ command: "account_lines", account: to });
    const line = (lines.result.lines || []).find(
      l => l.currency === CURRENCY_CODE && l.account === wallet.classicAddress
    );
    res.json({ ok: true, hasTrustline: !!line, line });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

// ── XUMM：一鍵建立信任線（產生簽名 Payload） ──
app.post("/api/xumm/trustset-payload", async (req, res) => {
  try {
    if (!xumm) throw new Error("XUMM 未啟用（缺少 API key/secret 或未安裝套件）");
    const limit = String(req.body?.limit || "1000000"); // 預設 100 萬

    const payload = {
      txjson: {
        TransactionType: "TrustSet",
        LimitAmount: {
          currency: CURRENCY_CODE,
          issuer:   wallet.classicAddress,
          value:    limit
        }
      },
      // 顯示在 XUMM 的自訂說明（非必填）
      custom_meta: {
        instruction: `Add trustline: ${CURRENCY_CODE} issued by ${wallet.classicAddress} (limit ${limit})`
      }
    };

    const created = await xumm.payload.create(payload, true); // true: 直接回 QR 與連結
    res.json({
      ok: true,
      uuid: created.uuid,
      link: created.next.always, // 在手機上直接開 Xaman
      qr: created.refs.qr_png    // 桌機顯示 QR 給手機掃
    });
  } catch (e) {
    console.error("xumm trustset payload error:", e);
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

// XUMM：輪詢簽名狀態
app.get("/api/xumm/trustset-status", async (req, res) => {
  try {
    if (!xumm) throw new Error("XUMM 未啟用");
    const uuid = req.query.uuid;
    if (!uuid) throw new Error("缺少 uuid");
    const p = await xumm.payload.get(uuid);
    res.json({
      ok: true,
      signed: !!p.meta.signed,
      expired: !!p.meta.expired,
      account: p.response?.account || null,
      txid: p.response?.txid || null
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || String(e) });
  }
});

// 單筆發送 KFD
app.post("/api/kfd/mint-single", async (req, res) => {
  try {
    const { to, amount } = req.body || {};
    if (!isClassicAddress(to)) throw new Error("接收地址格式錯誤");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) {
      throw new Error(`數量必須在 0 ~ ${MAX_AMOUNT} 之間`);
    }
    const { hash } = await sendIOU(to, String(n));
    res.json({ status: "success", hash });
  } catch (e) {
    console.error("❌ mint-single 失敗：", e);
    res.status(400).json({ status: "error", message: e.message || "mint 失敗" });
  }
});

// 批次發送（不中斷，逐筆回報）
app.post("/api/kfd/mint-batch", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({ status: "error", message: "items 不可為空" });
  }
  if (items.length > MAX_BATCH_ITEMS) {
    return res.status(400).json({ status: "error", message: `一次最多 ${MAX_BATCH_ITEMS} 筆` });
  }

  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const to = it.to;
    const n  = Number(it.amount);

    try {
      if (!isClassicAddress(to)) throw new Error("地址錯誤");
      if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) throw new Error("數量不合法");

      const r = await sendIOU(to, String(n));
      results.push({ index: i, to, amount: String(n), ok: true, hash: r.hash });
    } catch (err) {
      results.push({ index: i, to, amount: String(it.amount), ok: false, error: err.message || String(err) });
    }
  }

  const okCount  = results.filter(r => r.ok).length;
  const errCount = results.length - okCount;
  res.json({ status: errCount ? "partial" : "success", okCount, errCount, results });
});

// 關閉時斷線
process.on("SIGINT", async () => {
  if (client?.isConnected()) await client.disconnect();
  process.exit(0);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ KFD XRPL Minter API on http://localhost:${PORT}`);
});
