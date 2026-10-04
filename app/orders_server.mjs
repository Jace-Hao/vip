#!/usr/bin/env node
/* ============================================================
 * 洗衣管家 · 会员订单抓取操作台服务
 * ------------------------------------------------------------
 * 端口：127.0.0.1:8791（仅本机可访问）
 * 提供：
 *   GET  /            操作页面
 *   GET  /api/status  实时状态（阶段/进度/统计/日志）
 *   POST /api/start   开始抓取（可选 {"sample":N} 小批量试点）
 *   POST /api/stop    暂停（停止进程，进度保留，可继续）
 *   POST /api/rebuild 刷新查询页面数据
 *   POST /api/open    打开查询页面 / 数据文件夹
 *   GET  /api/schedule        查询定时同步设置
 *   POST /api/schedule        保存定时同步设置 {"enabled":true,"time":"23:00","shutdownAfter":true}
 *   POST /api/cancel_shutdown 取消待执行的自动关机
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto2 from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const OUT_DIR = path.join(ROOT, '导出结果', '订单数据');
const PAGE_FILE = path.join(ROOT, '操作页面.html');
const LOCK_PATH = path.join(OUT_DIR, '.orders_run.lock');
const JSONL_PATH = path.join(OUT_DIR, '.orders_results.jsonl');
const LOG_MAX = 500;
const SCHEDULE_FILE = path.join(ROOT, '.sync_schedule.json');
const TOKEN_FILE = path.join(ROOT, '.console_token.txt');
const HUB_FILE = path.join(ROOT, '控制中心.html');
const APP_EXE = 'D:\\Blending_Release-6.1.17\\xygjwinapp.exe';
const SHUTDOWN_DELAY = 120; // 同步完成后延迟关机秒数（期间可取消）

/* ---------------- 营业时段保护 ----------------
 * 抓取会占用洗衣管家账号的请求配额；历史观测该配额约 400 次/小时量级，
 * 在门店营业时段跑全量抓取会与正常业务抢配额，并曾导致账号被踢下线。
 * 默认仅记录醒目警告、不阻断；把 BUSINESS_GUARD_BLOCK 改为 true 后，
 * 营业时段将拒绝手动启动、定时同步也会自动跳过。
 * 建议：把定时同步时间设在 22:00 以后。
 */
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 20;
const BUSINESS_GUARD_BLOCK = false;

/**
 * 判断当前是否处于门店营业时段。
 * @returns {boolean} 处于营业时段返回 true
 */
function inBusinessHours() {
  const h = new Date().getHours();
  return h >= BUSINESS_START_HOUR && h < BUSINESS_END_HOUR;
}

/**
 * 营业时段提示：返回给调用方的告警文案（不在营业时段时返回空串）。
 * @returns {string} 告警文案
 */
function businessWarning() {
  if (!inBusinessHours()) return '';
  return `当前处于营业时段（${BUSINESS_START_HOUR}:00-${BUSINESS_END_HOUR}:00），全量抓取会与门店业务争抢洗衣管家的请求配额，历史上曾导致账号被踢下线。建议改在夜间（22:00 后）执行。`;
}

/* ---------------- 限速环境变量透传 ----------------
 * 子进程（export.mjs / fetch_orders.mjs）通过 spawn 默认继承本进程环境变量，
 * 因此在本服务启动前设置下列变量即可调整抓取节奏，无需改代码：
 *   LAUNDRY_MIN_INTERVAL_MS   相邻请求最小间隔（毫秒，默认 2200/1500）
 *   LAUNDRY_JITTER_MS         额外随机抖动上限（毫秒）
 * 例（夜间慢速）：set LAUNDRY_MIN_INTERVAL_MS=5000
 * 说明：已移除「每小时请求次数上限」，抓取节奏由最小间隔与抖动决定。
 */

/* 辅助进程完整环境块：服务可能从精简环境拉起，缺 COMPUTERNAME 等变量会导致 shutdown/taskkill 等系统工具报 203/128 */
const SHUTDOWN_ENV = (() => {
  const env = { ...process.env };
  const defaults = {
    COMPUTERNAME: process.env.COMPUTERNAME || os.hostname(),
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe', OS: 'Windows_NT',
    PATHEXT: '.COM;.EXE;.BAT;.CMD', TEMP: 'C:\\Windows\\TEMP', TMP: 'C:\\Windows\\TEMP',
    ALLUSERSPROFILE: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public', ProgramData: 'C:\\ProgramData',
  };
  for (const k of Object.keys(defaults)) if (!env[k]) env[k] = defaults[k];
  return env;
})();
const SHUTDOWN_EXE = 'C:\\Windows\\System32\\shutdown.exe';
const HELPER_ENV = SHUTDOWN_ENV; /* taskkill/tasklist/powershell 等辅助进程同样需要 */
const PWSH = fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : 'powershell';

let child = null;
let childKind = null; // deep | orders
let phase = 'idle';   // idle | deep | orders | paused | done | failed
let startedAt = null;
let lastExit = null;
let stopReq = false;
let runSample = 0;     // 本次启动的抽样人数：0 表示全量（决定阶段2 用 --all 还是 --sample=N）
let rebuilding = false;
let logBuf = [];
let baseStats = null;   // { members, withOrders, ordersSum, exportStamp }
let baseDone = 0;       // 启动抓取时 jsonl 已完成人数
let baseOrders = 0;     // 启动抓取时 jsonl 已有订单数
let phaseStartAt = null; // 当前阶段开始时刻（用于运行中实时估算剩余时间）
let state = {
  progress: { done: 0, total: 0, current: '', memberOrders: 0 },
  compare: null,
  deepProgress: null,
  cumulative: null,
  etaMin: null,
  totalWithOrders: null,
  ordersThisRun: 0,
};
let schedule = { enabled: false, time: '23:00', shutdownAfter: false, lastFiredDate: '' };
let shutdownPending = null;    // { since } 自动关机倒计时
let scheduleTriggered = false; // 当前抓取是否由定时同步触发
let schedBusy = false;
let lastCleanup = null;  // { at, atText, removed }
const KEEP_RUNS = 2;     // 自动清理保留的最近导出/抓取次数

function nowStr() { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
function pushLog(line) { logBuf.push(nowStr() + '  ' + line); if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX); }
function clearLock() { try { if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH); } catch (e) { /* ignore */ } }

/* ---- 订单 JSONL 统计：mtime 缓存 + 增量解析 + uid 去重 ----
   性能背景（本机实测，数据量约 1846 人 / 1.7 万单）：
     .orders_results.jsonl 曾达 175MB。原实现每次调用都全量读取 + 逐行 JSON.parse，
     单次耗时 1082ms（其中读盘约 440ms、JSON 解析约 640ms）。
     而 /api/hub/status 由控制中心每 3 秒轮询一次，等于每 3 秒把事件循环堵住 1 秒以上，
     期间所有并发请求（含首屏、导出、隧道）全部排队 —— 这是工具箱启动慢的首要原因。
   优化：该文件由抓取脚本 fs.appendFileSync 追加写入（只增不改），因此改为：
     1) mtime + size 均未变化 → 直接返回缓存，O(1)；
     2) 有新增 → 只读取 [offset, size) 区间并解析新增的完整行，累加到缓存计数；
     3) 末行未写完（无换行符）时停在最后一个换行处，残余留给下次，避免解析半行；
     4) 文件被截断，或被删除重建后增长超过旧 offset（靠文件头指纹识别）→ 全量重算。
   统计口径：**按 uid 去重，后写入的行覆盖同 uid 的旧值**。
     与 build_viewer.py 的 order_map[uid] 覆盖式赋值、查询页分片按 uid 去重完全一致。
     早期实现按行累加，同一 uid 被续传重写时会重复计数，使控制中心显示的订单数虚高
     （实测 18241，而真实唯一订单为 17572），且与查询页显示对不上。
   5) 跨进程记忆：把 {size, mtimeMs, members, orders, byUid} 落到 .dev/.jsonl_stat.json，
      重启服务/重开工具箱时若 size+mtimeMs 未变，直接读盘（<1ms）跳过全量解析。
      校验不通过就丢弃重算，因此不存在脏读风险。 */
/* 文件头指纹：取前 256 字节的 sha1。用于识别「文件被删除重建但新文件已增长到
   超过旧 offset」的情况——此时 size/mtime 单靠比较无法察觉（见 readJsonlStats）。 */
function jsonlHead() {
  try {
    const fd = fs.openSync(JSONL_PATH, 'r');
    try {
      const buf = Buffer.allocUnsafe(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      return crypto2.createHash('sha1').update(buf.slice(0, n)).digest('hex');
    } finally { fs.closeSync(fd); }
  } catch (e) { return ''; }
}
function jsonlHeadMatch() {
  const cur = jsonlHead();
  if (!cur) return true;          /* 读不到就不过度反应，交给后续解析兜底 */
  if (!jsonlCache.head) { jsonlCache.head = cur; return true; }
  return cur === jsonlCache.head;
}
const jsonlCache = { size: -1, mtimeMs: -1, offset: 0, members: 0, orders: 0, byUid: null, head: '' };
const JSONL_STAT_MEMO = path.join(ROOT, '.dev', '.jsonl_stat.json');
function jsonlMemoLoad(st) {
  try {
    const j = JSON.parse(fs.readFileSync(JSONL_STAT_MEMO, 'utf8'));
    if (j && j.size === st.size && j.mtimeMs === st.mtimeMs && j.members >= 0 && j.orders >= 0) {
      jsonlCache.size = st.size; jsonlCache.mtimeMs = st.mtimeMs;
      jsonlCache.offset = st.size; jsonlCache.members = j.members; jsonlCache.orders = j.orders;
      /* 恢复每个 uid 的订单数，使后续追加仍能正确「覆盖旧值」而不是重复累加 */
      jsonlCache.byUid = (j.byUid && typeof j.byUid === 'object') ? j.byUid : null;
      if (!jsonlCache.byUid) { jsonlCache.members = j.members; jsonlCache.orders = j.orders; jsonlCache.byUid = null; }
      jsonlCache.head = jsonlHead();
      return true;
    }
  } catch (e) { /* 无记忆文件或格式不符 → 正常解析 */ }
  return false;
}
function jsonlMemoSave() {
  const c = jsonlCache;
  if (c.size < 0) return;
  try {
    fs.mkdirSync(path.dirname(JSONL_STAT_MEMO), { recursive: true });
    const payload = { size: c.size, mtimeMs: c.mtimeMs, members: c.members, orders: c.orders };
    if (c.byUid) payload.byUid = c.byUid;
    fs.writeFileSync(JSONL_STAT_MEMO + '.tmp', JSON.stringify(payload), 'utf8');
    fs.renameSync(JSONL_STAT_MEMO + '.tmp', JSONL_STAT_MEMO);
  } catch (e) { /* 记忆写入失败只影响下次启动速度，不影响本次结果 */ }
}
function readJsonlStats() {
  let st;
  try { st = fs.statSync(JSONL_PATH); } catch (e) { return { members: 0, orders: 0 }; }
  const c = jsonlCache;
  if (st.size === c.size && st.mtimeMs === c.mtimeMs) return { members: c.members, orders: c.orders };
  if (jsonlMemoLoad(st)) return { members: c.members, orders: c.orders };
  /* 失效判定（两者任一成立即全量重来）：
       1) size < offset → 被截断；
       2) 文件头指纹变化 → 被删除重建后重新增长到超过旧 offset。
          仅靠 size 判定不够：抓取脚本第 7 天会 unlinkSync 重建文件，若服务仍在运行，
          新文件增长超过旧 offset 后 st.size >= c.offset 成立，会从陈旧位置继续解析，
          导致统计错误。文件头指纹能可靠识别「这是另一个文件」。 */
  let needFull = false;
  if (st.size < c.offset) needFull = true;
  else if (c.offset > 0 && !jsonlHeadMatch()) needFull = true;
  if (needFull) { c.offset = 0; c.members = 0; c.orders = 0; c.byUid = null; c.head = jsonlHead(); }
  try {
    const len = st.size - c.offset;
    if (len > 0) {
      const buf = Buffer.allocUnsafe(len);
      const fd = fs.openSync(JSONL_PATH, 'r');
      try { fs.readSync(fd, buf, 0, len, c.offset); } finally { fs.closeSync(fd); }
      /* offset 永远落在 \n（单字节）之后，故此处必是合法 UTF-8 字符边界，不会截断多字节字符 */
      const nl = buf.lastIndexOf(0x0A);
      if (nl >= 0) {
        /* 口径：按 uid 去重，后写入的行覆盖同 uid 的旧值（与 build_viewer.py 的
           order_map[uid] = ... 覆盖式赋值、查询页分片按 uid 去重完全一致）。
           原实现按行累加，同一 uid 被续传重写时会重复计数，导致控制中心显示的
           订单数虚高（实测 18241 vs 真实唯一订单 17572）且与查询页对不上。 */
        const byUid = c.byUid || new Map();
        for (const ln of buf.toString('utf8', 0, nl + 1).split('\n')) {
          if (!ln) continue;
          try {
            const o = JSON.parse(ln);
            if (o && o.uid != null) {
              byUid.set(String(o.uid), o.orderCount != null ? Number(o.orderCount) : (o.orders || []).length);
            }
          } catch (e) { /* 坏行忽略，与原实现一致 */ }
        }
        c.byUid = byUid;
        let sum = 0;
        for (const v of byUid.values()) sum += v;
        c.members = byUid.size; c.orders = sum;
        c.offset += nl + 1;
      }
    }
  } catch (e) { /* 读取失败沿用上次计数，下轮重试 */ }
  c.size = st.size; c.mtimeMs = st.mtimeMs;
  if (!c.head) c.head = jsonlHead();
  jsonlMemoSave();
  return { members: c.members, orders: c.orders };
}

/* 启动预热：统计基线（导出结果 JSON + 订单 JSONL）。
   原实现放在 server.listen 之前同步执行，端口要等约 1.2s 才开始监听，
   Electron 主进程 portOpen/waitServer 轮询期间一直连不上，直接拉长工具箱启动时间。
   现改为监听成功后异步预热；操作台接口在预热完成前调用 ensureWarm() 兜底，
   保证 totalMembers 等字段的语义与原来完全一致（不会返回错误的 0）。 */
let warmReady = false;
function ensureWarm() {
  if (warmReady) return;
  warmReady = true;
  try { baseStats = loadBaseStats(); } catch (e) { baseStats = null; }
  try { const js0 = readJsonlStats(); baseDone = js0.members; baseOrders = js0.orders; } catch (e) { /* ignore */ }
}

function loadBaseStats() {
  try {
    const dir = path.join(ROOT, '导出结果');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('会员导出_') && f.endsWith('.json')).sort();
    if (!files.length) return null;
    const j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    const keys = (j.fullHeaders || []).map((h) => { const m = /（([^（）]+)）\s*$/.exec(h); return m ? m[1] : h; });
    let withOrders = 0, ordersSum = 0;
    for (const r of (j.fullRows || [])) {
      const m = {}; keys.forEach((k, i) => { m[k] = r[i]; });
      const n = Number(m.onum) || 0; ordersSum += n; if (n > 0) withOrders++;
    }
    return { members: (j.fullRows || []).length, withOrders, ordersSum, exportStamp: (j.exportStamp || '') };
  } catch (e) { return null; }
}

/* ---------------- 访问口令（外网暴露用） ---------------- */
function loadToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t.length >= 6) return t;
    }
  } catch (e) { /* ignore */ }
  /* 首次自动生成：8 位易读口令（去掉易混淆字符） */
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  const buf = crypto2.randomBytes(6);
  for (const b of buf) code += alphabet[b % alphabet.length];
  try { fs.writeFileSync(TOKEN_FILE, code, 'utf8'); } catch (e) { /* ignore */ }
  pushLog('已生成访问口令：' + code + '（保存于 .console_token.txt，可自行修改后重启服务）');
  return code;
}
function checkAuth(req) {
  const h = req.headers || {};
  if (h['x-console-token'] === CONSOLE_TOKEN) return true;
  const q = (req.url || '').split('?')[1] || '';
  const m = /(?:^|&)token=([^&]*)/.exec(q);
  if (m && decodeURIComponent(m[1]) === CONSOLE_TOKEN) return true;
  const cookie = h.cookie || '';
  const cm = /(?:^|;\s*)xconsole=([^;]*)/.exec(cookie);
  return !!(cm && decodeURIComponent(cm[1]) === CONSOLE_TOKEN);
}
function sendLoginPage(res, msg) {
  const m = msg ? String(msg).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) : '';
  const body = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>操作台登录</title>' +
    '<style>body{font-family:"Microsoft YaHei",sans-serif;background:#f4f6fb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}' +
    '.box{background:#fff;border:1px solid #e2e6ee;border-radius:12px;padding:34px 38px;max-width:360px;width:92%}' +
    'h1{font-size:19px;margin:0 0 6px}.sub{color:#5b6675;font-size:13px;margin:0 0 18px}' +
    'input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:16px;border:1px solid #c9d2e3;border-radius:9px;font-family:inherit;letter-spacing:2px}' +
    'button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:9px;background:#2b54a8;color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}' +
    '.err{color:#c94f4f;font-size:13px;min-height:18px;margin-top:10px}</style></head><body><div class="box">' +
    '<h1>会员数据操作台</h1><p class="sub">请输入访问口令（本机保存在工具目录 .console_token.txt）</p>' +
    '<form method="get" action="/"><input name="token" placeholder="访问口令" autofocus autocomplete="off"><button>进入操作台</button><div class="err">' + m + '</div></form>' +
    '</div></body></html>';
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------------- 定时同步 & 自动关机 ---------------- */
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function loadSchedule() {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const j = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
      if (j && typeof j === 'object') schedule = { enabled: !!j.enabled, time: /^\d{1,2}:\d{2}$/.test(j.time || '') ? j.time : '23:00', shutdownAfter: !!j.shutdownAfter, lastFiredDate: j.lastFiredDate || '' };
    }
  } catch (e) { /* ignore */ }
}
function saveSchedule() { try { fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8'); } catch (e) { pushLog('[警告] 定时设置保存失败：' + e.message); } }

async function cdpOk(timeoutMs) {
  try { await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(timeoutMs || 2000) }); return true; } catch (e) { return false; }
}

/* 确保洗衣管家以调试模式运行；必要时自动重启软件（带进程退出验证与并发去重） */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
function appProcCount() {
  return new Promise((resolve) => {
    let out = '';
    const ch = spawn('tasklist', ['/FI', 'IMAGENAME eq xygjwinapp.exe', '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], env: HELPER_ENV, windowsHide: true });
    ch.stdout.on('data', (d) => { out += d.toString(); });
    ch.on('exit', () => { resolve((out.match(/xygjwinapp/gi) || []).length); });
    ch.on('error', () => resolve(0));
  });
}
let ensurePromise = null;
function ensureDebugApp() {
  if (ensurePromise) { pushLog('调试模式检查已在进行中，等待上一次检查完成...'); return ensurePromise; }
  ensurePromise = doEnsureDebugApp().finally(() => { ensurePromise = null; });
  return ensurePromise;
}
async function doEnsureDebugApp() {
  if (await cdpOk()) return true;
  pushLog('调试端口未就绪，自动重启洗衣管家（调试模式）...');
  if (!fs.existsSync(APP_EXE)) { pushLog('[错误] 找不到洗衣管家主程序：' + APP_EXE); return false; }
  /* 1) 结束现有实例：温和 → taskkill 强杀 → PowerShell 兜底，每步验证进程真正退出 */
  let killed = false;
  /* 首选 PowerShell Stop-Process（实测对洗衣管家有效；taskkill 会报拒绝访问），全部带完整环境块 */
  await new Promise((resolve) => { const ch = spawn(PWSH, ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Stop-Process -Name xygjwinapp -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore', env: HELPER_ENV, windowsHide: true }); ch.on('exit', resolve); ch.on('error', resolve); });
  for (let i = 0; i < 10 && !killed; i++) { await nap(1000); if ((await appProcCount()) === 0) killed = true; }
  if (!killed) {
    pushLog('PowerShell 强制结束未生效，改用 taskkill ...');
    const rc = await new Promise((resolve) => { const ch = spawn('taskkill', ['/F', '/T', '/IM', 'xygjwinapp.exe'], { stdio: 'ignore', env: HELPER_ENV, windowsHide: true }); ch.on('exit', (c) => resolve(c)); ch.on('error', () => resolve(-1)); });
    for (let i = 0; i < 8 && !killed; i++) { await nap(1000); if ((await appProcCount()) === 0) killed = true; }
    if (!killed) pushLog('taskkill 亦未成功（退出码 ' + rc + '）');
  }
  if (!killed) { pushLog('[错误] 洗衣管家无法自动关闭（可能弹有确认框或被占用）。请手动完全退出软件后，再点「开始抓取」。'); return false; }
  pushLog('洗衣管家已退出，正在以调试模式重新启动...');
  await nap(1500);
  /* 2) 调试模式启动并等待端口就绪 */
  try { spawn('cmd.exe', ['/c', 'start', '', APP_EXE, '--remote-debugging-port=9222'], { cwd: path.dirname(APP_EXE), stdio: 'ignore', detached: true, env: HELPER_ENV }); } catch (e) { pushLog('[错误] 启动洗衣管家失败：' + e.message); return false; }
  for (let i = 0; i < 40; i++) {
    await nap(3000);
    if (await cdpOk(1500)) { pushLog('洗衣管家已进入调试模式。'); return true; }
  }
  pushLog('[错误] 等待洗衣管家调试端口超时（120 秒）。请确认软件已打开并登录，或手动用「以调试模式启动洗衣管家.cmd」重开。');
  return false;
}


function doShutdown() {
  if (shutdownPending) return;
  shutdownPending = { since: Date.now() };
  pushLog('⚡ 同步完成：系统将在 ' + SHUTDOWN_DELAY + ' 秒后自动关机（可在本页面点「取消关机」）。');
  try {
    const ch = spawn(SHUTDOWN_EXE, ['/s', '/t', String(SHUTDOWN_DELAY), '/c', '订单数据同步完成，系统即将关机'], { stdio: 'ignore', detached: true, env: SHUTDOWN_ENV, windowsHide: true });
    ch.on('error', (e) => { pushLog('[错误] 关机命令启动失败：' + e.message); shutdownPending = null; });
    ch.on('exit', (code) => { if (code !== 0) { pushLog('[错误] 关机命令执行失败（代码 ' + code + '），已取消本次自动关机。'); shutdownPending = null; } });
  } catch (e) { pushLog('[错误] 关机命令执行失败：' + e.message); shutdownPending = null; }
}

function cancelShutdown() {
  if (!shutdownPending) return { error: '当前没有待执行的关机' };
  try { const ch = spawn(SHUTDOWN_EXE, ['/a'], { stdio: 'ignore', env: SHUTDOWN_ENV, windowsHide: true }); ch.on('error', () => {}); } catch (e) { /* ignore */ }
  shutdownPending = null;
  pushLog('已取消自动关机。');
  return { ok: true };
}

async function schedulerTick() {
  if (!schedule.enabled || schedBusy || shutdownPending) return;
  if (child || rebuilding) return;
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule.time || '');
  if (!m) return;
  const now = new Date();
  const fire = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], 0);
  const diff = now - fire;
  if (diff < 0 || diff > 10 * 60 * 1000) return; // 未到时间 / 错过超过10分钟（次日再触发）
  const today = todayStr();
  if (schedule.lastFiredDate === today) return;
  schedule.lastFiredDate = today; saveSchedule();
  schedBusy = true;
  pushLog('⏰ 定时同步触发（每天 ' + schedule.time + (schedule.shutdownAfter ? ' · 同步后自动关机' : '') + '）');
  try {
    if (BUSINESS_GUARD_BLOCK && inBusinessHours()) {
      pushLog('营业时段保护已开启：当前处于营业时段，本次定时同步跳过（建议把定时时间改到 22:00 之后）。');
      scheduleTriggered = false;
      return;
    }
    if (fs.existsSync(LOCK_PATH)) {
      let lockAlive = false;
      try { const lp = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10); if (lp > 0) { try { process.kill(lp, 0); lockAlive = true; } catch (e) { lockAlive = false; } } } catch (e) { /* ignore */ }
      if (lockAlive) { pushLog('检测到已有抓取任务在运行，本次定时同步跳过。'); return; }
      clearLock();
      pushLog('发现残留的陈旧锁文件，已自动清理。');
    }
    const ok = await ensureDebugApp();
    if (!ok) { pushLog('本次定时同步取消（不执行关机）。'); return; }
    scheduleTriggered = true;
    const r = await start(0);
    if (r && r.error) { scheduleTriggered = false; pushLog('定时同步启动失败：' + r.error); }
  } finally { schedBusy = false; }
}

/* ---------------- 自动清理过时数据（保留最近 KEEP_RUNS 次） ---------------- */
function collectStamped(dir, prefixes) {
  const map = new Map();
  try {
    if (!fs.existsSync(dir)) return map;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('.')) continue;
      if (!prefixes.some((p) => f.startsWith(p))) continue;
      const m = /_(\d{8}_\d{6})\./.exec(f);
      if (!m) continue;
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(full);
    }
  } catch (e) { /* ignore */ }
  return map;
}

function recycleFiles(files) {
  return new Promise((resolve) => {
    if (!files.length) return resolve(0);
    const script = 'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
      files.map((f) => `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${f.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`).join('; ');
    const ch = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore', windowsHide: true });
    ch.on('exit', (c) => resolve(c === 0 ? files.length : 0));
    ch.on('error', () => resolve(0));
  });
}

async function cleanupOldData() {
  try {
    const scopes = [
      { dir: path.join(ROOT, '导出结果'), prefixes: ['会员导出_', '会员全量数据_', '会员详情_'] },
      { dir: OUT_DIR, prefixes: ['订单_', '订单试点预览_', '会员订单_'] },
    ];
    let total = 0;
    for (const sc of scopes) {
      const map = collectStamped(sc.dir, sc.prefixes);
      const stamps = [...map.keys()].sort().reverse();
      const dead = [];
      for (const s of stamps.slice(KEEP_RUNS)) dead.push(...map.get(s));
      /* 被占用的文件自动跳过（如正在打开的 Excel） */
      const deletable = [];
      for (const f of dead) { try { const fd = fs.openSync(f, 'r+'); fs.closeSync(fd); deletable.push(f); } catch (e) { /* 跳过 */ } }
      if (deletable.length) total += await recycleFiles(deletable);
    }
    lastCleanup = { at: Date.now(), atText: nowStr(), removed: total };
    pushLog(total > 0
      ? `🧹 已自动清理过时数据：移除 ${total} 个旧文件（保留最近 ${KEEP_RUNS} 次，已移入回收站可恢复）`
      : `🧹 数据检查完成：无需清理（各保留最近 ${KEEP_RUNS} 次导出/抓取）。`);
    return total;
  } catch (e) {
    pushLog('[警告] 数据清理出错：' + e.message);
    return 0;
  }
}

/* ---------------- 子进程管理 ---------------- */
function wireChild(ch) {
  let buf = '';
  const feed = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) { pushLog(line); parseLine(line); }
    }
  };
  ch.stdout.on('data', feed);
  ch.stderr.on('data', feed);
  /* 子进程 spawn 失败（如 node.exe 路径异常）时 ChildProcess 会抛 'error'。
     原实现没有监听，会变成未捕获异常直接把服务端搞崩——这里兜住并写入日志。 */
  ch.on('error', (e) => {
    pushLog('[错误] 抓取进程启动失败：' + ((e && e.message) || '未知原因'));
    if (child === ch) { child = null; phase = 'failed'; clearLock(); }
  });
}

function parseLine(line) {
  let m = line.match(/\[(\d+)\/(\d+)\]\s*(.+?)：(\d+) 单/);
  if (m) { state.progress.done = +m[1]; state.progress.total = +m[2]; state.progress.current = m[3]; state.progress.memberOrders = +m[4]; state.ordersThisRun += +m[4]; return; }
  m = line.match(/数据比对：无需更新 (\d+) 人，需抓取 (\d+) 人（新增 (\d+)、有变化 (\d+)）/);
  if (m) { state.compare = { skip: +m[1], fetch: +m[2], newN: +m[3], chgN: +m[4] }; return; }
  m = line.match(/含订单会员共 (\d+) 人/);
  if (m) { state.totalWithOrders = +m[1]; return; }
  m = line.match(/详情进度 (\d+) \/ (\d+)/);
  if (m) { state.deepProgress = { done: +m[1], total: +m[2] }; return; }
  m = line.match(/共 (\d+) 人、(\d+) 单/);
  if (m) { state.cumulative = { members: +m[1], orders: +m[2] }; return; }
  m = line.match(/剩余 (\d+) 人约需 (\d+) 分钟/);
  if (m) { state.etaMin = +m[2]; return; }
  m = line.match(/\[错误\] (.+)/);
  if (m) { state.lastError = m[1]; }
}

function spawnPhase(kind) {
  /* 阶段2 遵循本次启动时的抽样设置：试点(sample>0)时只抓抽样会员，绝不能默认跑成全量 --all */
  const args = kind === 'deep'
    ? ['app/export.mjs', '--deep']
    : ['app/fetch_orders.mjs', runSample > 0 ? ('--sample=' + runSample) : '--all'];
  childKind = kind;
  phase = kind;
  phaseStartAt = Date.now();
  /* windowsHide:true —— 关键：抓取进程在后台静默运行，不弹出 node.exe 黑色命令行窗口。
     detached 不使用（需保持父子关系以便 stop 时能精确 kill 进程树）。 */
  child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  pushLog(kind === 'deep'
    ? '阶段1：会员详情增量更新已启动'
    : (runSample > 0 ? `阶段2：订单抓取已启动（抽样试点 ${runSample} 人）` : '阶段2：订单全量抓取已启动'));
  wireChild(child);
  child.on('exit', (code) => {
    child = null;
    if (stopReq) { phase = 'paused'; pushLog('已暂停（进度保留，点击“开始/继续”可续传）'); clearLock(); stopReq = false; scheduleTriggered = false; return; }
    if (childKind === 'deep') {
      if (code === 0) { pushLog('会员详情增量更新完成，继续订单抓取...'); spawnPhase('orders'); }
      else { phase = 'failed'; lastExit = { kind: 'deep', code }; scheduleTriggered = false; pushLog('会员详情更新异常退出（代码 ' + code + '），已停止。'); clearLock(); }
    } else {
      phase = code === 0 ? 'done' : 'failed';
      lastExit = { kind: 'orders', code };
      pushLog(code === 0 ? '订单抓取完成。' : ('订单抓取进程退出（代码 ' + code + '）'));
      clearLock();
      const wantShutdown = schedule.shutdownAfter; /* 勾选“同步后关机”即生效（手动/定时均适用） */
      scheduleTriggered = false;
      cleanupOldData().then(() => {
        const r2 = rebuild(wantShutdown);
        if (r2 && r2.ok) pushLog('正在自动刷新查询页面数据...');
        else if (wantShutdown) doShutdown();
      });
    }
  });
}

async function start(sample) {
  if (child) return { error: '已有任务在运行' };
  /* 控制中心（/api/hub/export）可能正在导出。两者若并发会同时向洗衣管家发请求，
     拉动整体请求速率超出预期（且互相抢进度），这里与 /api/hub/export 的
     `if (child)` 守卫对称，保证同一时刻只有一个抓取进程。 */
  if (hubChild) return { error: '控制中心正在导出会员数据，请等其完成后再启动抓取' };
  /* 营业时段保护：默认告警；BUSINESS_GUARD_BLOCK 为 true 时直接拒绝 */
  if (inBusinessHours()) {
    pushLog('⚠️ ' + businessWarning());
    if (BUSINESS_GUARD_BLOCK && !sample) return { error: businessWarning() };
  }
  /* 手动启动同样确保洗衣管家处于调试模式（未开/未带端口时自动重启软件） */
  const dbg = await ensureDebugApp();
  if (!dbg) return { error: '洗衣管家未能进入调试模式，请手动完全退出软件后，用「以调试模式启动洗衣管家.cmd」重开再试' };
  stopReq = false; lastExit = null;
  runSample = sample > 0 ? sample : 0;
  state = { progress: { done: 0, total: 0, current: '', memberOrders: 0 }, compare: null, deepProgress: null, cumulative: null, etaMin: null, totalWithOrders: state.totalWithOrders, ordersThisRun: 0, lastError: null };
  const js = readJsonlStats();
  baseDone = js.members; baseOrders = js.orders;
  clearLock();
  startedAt = new Date().toISOString();
  spawnPhase('deep');
  if (schedule.shutdownAfter) pushLog('⚡ 已开启「同步后关机」：本次同步完成后约 ' + SHUTDOWN_DELAY + ' 秒自动关机（完成前可随时取消）。');
  return { ok: true, sample: sample > 0 ? sample : 'all' };
}

function stop() {
  if (!child) return { error: '没有正在运行的任务' };
  stopReq = true;
  try { child.kill(); } catch (e) { /* ignore */ }
  setTimeout(clearLock, 800);
  return { ok: true };
}

function rebuild(thenShutdown) {
  if (rebuilding) return { error: '正在生成中，请稍候' };
  const py = path.join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'python.exe');
  const exe = fs.existsSync(py) ? py : 'python';
  rebuilding = true;
  const ch = spawn(exe, ['app/build_viewer.py'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  ch.on('exit', (code) => {
    rebuilding = false;
    pushLog(code === 0 ? '查询页面数据已刷新' : '查询页面数据刷新失败');
    if (thenShutdown) doShutdown();
  });
  return { ok: true };
}

/* ---------------- 状态 ---------------- */
/* 运行中实时估算剩余时间（分钟）。
   背景：子进程的 ETA 日志行只在 runBatch 全部结束时打印一次（fetch_orders.mjs 收尾处），
   运行中途永远不会有，前端因此一直显示「估算中」。这里改为服务端基于阶段进度自行估算：
   - orders 阶段：todo 全部需要实际抓取、[i+1]/total 每次启动从 0 递增，总体平均速率可靠；
   - deep 阶段：「详情进度」在增量模式下包含大量直接跳过的会员（速率忽快忽慢），
     用它算出的 ETA 会严重失真，故不做估算，由前端诚实兜底显示「—」。
   日志解析得到的 state.etaMin 仍保留优先（兼容未来子进程若输出运行中 ETA）。 */
function etaNow() {
  if (state.etaMin != null) return state.etaMin;
  if (!child || !phaseStartAt) return null;
  if (phase !== 'orders') return null;
  const p = state.progress;
  if (!p || p.total <= 0 || p.done <= 0 || p.total <= p.done) return null;
  const elapsedMin = (Date.now() - phaseStartAt) / 60000;
  if (elapsedMin <= 0) return null;
  return Math.max(1, Math.round(elapsedMin / p.done * (p.total - p.done)));
}

/* 调试端口探测结果缓存。
   原实现每次 /api/hub/status 都发起一次到 9222 的 fetch 并 await：
   端口未开时必然耗满 1.5s 超时才返回「不可用」，把整个状态接口拖到 1.5s+。
   探测结果在秒级不会变化，按 TTL 缓存即可；CDP 的实际用途（抓取前 ensure-debug）
   走独立接口，不受此缓存影响，因此不会影响「检测/重启进调试模式」的准确性。 */
const CDP_TTL_OK = 5000;    // 探测成功：端口在监听，状态稳定，缓存久一点
const CDP_TTL_FAIL = 2000;  // 探测失败：端口可能随时被打开，缓存短一点
let cdpCache = { at: 0, val: '不可用' };
let cdpPending = null;
async function cdpCheck() {
  const now = Date.now();
  const ttl = cdpCache.val === 'ok' ? CDP_TTL_OK : CDP_TTL_FAIL;
  if (cdpCache.val && now - cdpCache.at < ttl) return cdpCache.val;
  /* 并发去重：3 秒轮询 + 首屏可能同时打进来，避免重复发起探测 */
  if (cdpPending) return cdpPending;
  cdpPending = (async () => {
    let val = '不可用';
    try { await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(1500) }); val = 'ok'; } catch (e) { /* 不可用 */ }
    cdpCache = { at: Date.now(), val };
    cdpPending = null;
    return val;
  })();
  return cdpPending;
}

async function statusPayload() {
  /* 预热兜底：后台预热尚未完成时同步补齐，保证 totalMembers / baseDone / baseOrders
     不会因启动顺序调整而短暂显示为 0（口径与优化前完全一致）。 */
  ensureWarm();
  const running = !!child;
  const jsNow = running ? null : readJsonlStats();
  const doneMembers = running ? (baseDone + state.progress.done) : (jsNow ? jsNow.members : 0);
  const ordersTotal = running ? (baseOrders + state.ordersThisRun) : (jsNow ? jsNow.orders : 0);
  return {
    phase,
    phaseText: ({ idle: '未运行', deep: '阶段1：会员详情增量更新', orders: '阶段2：订单抓取', paused: '已暂停（进度保留）', done: '已完成', failed: '异常退出' })[phase] || phase,
    running,
    childKind,
    startedAt,
    lastExit,
    elapsedSec: startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0,
    progress: state.progress,
    compare: state.compare,
    deepProgress: state.deepProgress,
    etaMin: etaNow(),
    stats: {
      totalMembers: baseStats ? baseStats.members : null,
      withOrders: baseStats ? baseStats.withOrders : null,
      ordersSum: baseStats ? baseStats.ordersSum : null,
      doneMembers,
      ordersTotal,
    },
    cdp: await cdpCheck(),
    rebuilding,
    schedule: { enabled: schedule.enabled, time: schedule.time, shutdownAfter: schedule.shutdownAfter, lastFiredDate: schedule.lastFiredDate },
    lastCleanup,
    shutdownPendingSecs: shutdownPending ? Math.max(0, SHUTDOWN_DELAY - Math.round((Date.now() - shutdownPending.since) / 1000)) : 0,
    serverPort: PORT,
    logTail: logBuf.slice(-25),
  };
}

/* ---------------- 控制中心（入口集成） ---------------- */
const HUB_LOG = path.join(ROOT, '.dev', 'hub_export.log');
const CLOUDFLARED = path.join(ROOT, 'app', 'cloudflared.exe');
const TUNNEL_LOG = path.join(ROOT, '.dev', 'tunnel.err.log');
const AUTOSTART_FLAG = path.join(ROOT, '.dev', 'autostart.flag'); // 标记「已配置开机自启」（辅助状态显示，真实状态以启动文件夹文件为准）

/* ---------------- 开机自启 ----------------
 * 主用方式：往当前用户的「启动」文件夹投放一个 .vbs 脚本，登录 Windows 后自动执行。
 *   纯文件读写，不调用任何外部进程、不需要管理员权限，登录自启行为等价于 ONLOGON 计划任务。
 *
 * 关键设计：所有文件操作都用「异步 fs + 超时」，绝不用 fs.writeFileSync 这类同步调用。
 *   同步写盘一旦被系统/安全软件/沙箱卡住，会阻塞 Node 整个事件循环，表现为「点了没反应」，
 *   连状态轮询都会一起超时——这正是此前开机自启按钮失效的真正机制。
 *   异步 + 超时保证：即使目标目录不可写，最长 6 秒后也会返回可读的错误，服务始终可用。
 */
const STARTUP_DIR = path.join(process.env.APPDATA || path.join(os.homedir() || '', 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_VBS = path.join(STARTUP_DIR, '洗衣管家会员导出-开机自启.vbs');
const STARTUP_LNK = path.join(STARTUP_DIR, '洗衣管家会员导出-开机自启.lnk');
const STARTUP_TIMEOUT_MS = 6000;   // 启动文件夹操作超时；超过即视为不可用

/* 主用格式：.lnk 快捷方式（Windows 启动文件夹原生支持）。
 * 之所以不用 .vbs/.cmd 脚本：不少安全软件（含部分受限运行环境）会把「启动文件夹里的
 * 脚本文件」当作可疑持久化行为直接拦截/删除，导致安装永远失败且无提示。
 * .lnk 是标准二进制快捷方式，不含脚本内容，能绕过该类启发式拦截。 */

/** 生成指向 wscript.exe 的 .lnk 二进制内容（无窗口执行 VBS）
 *  结构遵循 MS-SHLLINK：ShellLinkHeader(0x4C) + LinkTargetIDList + StringData + TerminalBlock */
function buildLnk(targetExe, targetArgs, workDir) {
  const S = (s) => Buffer.from(s, 'utf16le');
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; };

  /* --- ShellLinkHeader：固定 0x4C(76) 字节 --- */
  const header = Buffer.alloc(0x4C);
  header.writeUInt32LE(0x4C, 0x00);   // HeaderSize
  // LinkCLSID = {00021401-0000-0000-C000-000000000046}
  Buffer.from([0x01,0x14,0x02,0x00,0x00,0x00,0x00,0x00,0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]).copy(header, 0x04);
  // LinkFlags(0x14)=HasLinkTargetIDList|HasWorkingDir|HasArguments|IsUnicode
  //   注意：不要设 HasName/HasRelativePath —— 设了它们就必须额外输出对应字符串，
  //   否则 StringData 顺序错位，Windows 解析不出启动参数（快捷方式等于失效）。
  header.writeUInt32LE(0x01 | 0x10 | 0x20 | 0x80, 0x14);
  header.writeUInt32LE(0, 0x18);      // FileAttributes
  header.writeUInt32LE(0, 0x1C); header.writeUInt32LE(0, 0x20);  // CreationTime
  header.writeUInt32LE(0, 0x24); header.writeUInt32LE(0, 0x28);  // AccessTime
  header.writeUInt32LE(0, 0x2C); header.writeUInt32LE(0, 0x30);  // WriteTime
  header.writeUInt32LE(0, 0x34);      // FileSize
  header.writeInt32LE(0, 0x38);       // IconIndex
  header.writeUInt32LE(0, 0x3C);      // ShowCommand = 0 (SW_HIDE，登录时不弹黑窗)
  header.writeUInt16LE(0, 0x40);      // HotKey
  header.writeUInt16LE(0, 0x42);      // Reserved
  header.writeUInt32LE(0, 0x44);      // Reserved2
  header.writeUInt32LE(0, 0x48);      // Reserved3

  /* --- LinkTargetIDList：IDListSize(2) + LinkInfo + TerminalID(2) --- */
  const cli = Buffer.from([0x01,0x14,0x02,0x00,0x00,0x00,0x00,0x00,0xC0,0x00,0x00,0x00,0x00,0x00,0x00,0x46]);
  const exeU16 = S(targetExe);                       // LocalBasePath（含 NUL 结尾）
  const linkInfo = Buffer.alloc(0x1C + 16 + exeU16.length + 2);
  linkInfo.writeUInt32LE(linkInfo.length, 0x00);     // LinkInfoSize
  linkInfo.writeUInt32LE(0x1C, 0x04);                // LinkInfoHeaderSize
  linkInfo.writeUInt32LE(0x01, 0x08);                // LinkInfoFlags: VolumeIDAndLocalBasePath
  linkInfo.writeUInt32LE(0, 0x0C);                   // VolumeSerialOffset
  linkInfo.writeUInt32LE(0, 0x10);                   // VolumeLabelOffset
  linkInfo.writeUInt32LE(0x1C + 16, 0x14);           // LocalBasePathOffset
  linkInfo.writeUInt32LE(0, 0x18);                   // CommonNetworkRelativeLinkOffset
  linkInfo.writeUInt32LE(0, 0x1C);                   // CommonPathSuffixOffset
  cli.copy(linkInfo, 0x1C);
  exeU16.copy(linkInfo, 0x1C + 16);

  /* IDListSize(2 字节) 的语义是「LinkTargetIDList 总长度，含这 2 字节自身」，
     所以 = 2(自身) + linkInfo + 2(末尾 TerminalID)。写错会导致 StringData 偏移错位。 */
  const idList = Buffer.concat([u16(2 + linkInfo.length + 2), linkInfo, u16(0)]);

  /* --- StringData：顺序必须与 LinkFlags 一致。
       本处只设了 HasWorkingDir|HasArguments，故只需输出 WorkingDir 与 Arguments 两段，
       且都以 CountCharacters=0 的空串终止（即单个 0x0000）。 */
  const strings = Buffer.concat([S(workDir), Buffer.from([0x00, 0x00]), S(targetArgs), Buffer.from([0x00, 0x00])]);

  /* --- TerminalBlock --- */
  const terminal = Buffer.alloc(4);

  return Buffer.concat([header, idList, strings, terminal]);
}

/** 生成写入启动文件夹的 VBS（.lnk 方案的兜底目标脚本） */
function startupVbsContent() {
  const nodeExe = process.execPath;
  const script = path.join(ROOT, 'app', 'orders_server.mjs');
  return [
    "' 洗衣管家会员导出 · 开机自启（由控制中心自动生成，请勿手工编辑）",
    "' 登录 Windows 后由启动文件夹自动执行，静默启动本地服务（无命令行窗口）",
    'Option Explicit',
    'Dim sh',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.CurrentDirectory = "' + ROOT.replace(/"/g, '""') + '"',
    'sh.Run """" & "' + nodeExe.replace(/"/g, '""') + '" & """ "" "' + script.replace(/"/g, '""') + '""", 0, False',
    ''
  ].join('\r\n');
}

/** 给任意 promise 加超时，避免外部/文件系统卡住导致请求悬挂 */
function withTimeout(p, ms, msg) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

/** 安装开机自启（启动文件夹方式，异步）。
 *  优先写 .lnk 快捷方式（不被安全软件拦截）；失败再退回 .vbs。
 *  返回 {ok, how, error} */
async function installStartupEntry() {
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const fails = [];
  try {
    await withTimeout(fs.promises.mkdir(STARTUP_DIR, { recursive: true }), STARTUP_TIMEOUT_MS, '访问「启动」文件夹超时');
  } catch (e) {
    return { ok: false, how: '启动文件夹', error: '无法访问「启动」文件夹：' + ((e && e.message) || '未知原因') };
  }
  /* 方案1：.lnk（推荐，不含脚本内容，安全软件不会拦） */
  try {
    const lnk = buildLnk(wscript, '"' + path.join(ROOT, '开机自启-操作台服务.vbs') + '"', ROOT);
    await withTimeout(fs.promises.writeFile(STARTUP_LNK, lnk), STARTUP_TIMEOUT_MS, '写入超时');
    await withTimeout(fs.promises.unlink(STARTUP_VBS).catch((e) => { if (e && e.code !== 'ENOENT') throw e; }), STARTUP_TIMEOUT_MS, 'x').catch(() => {});
    return { ok: true, how: '启动文件夹快捷方式(.lnk)' };
  } catch (e) {
    const why = /超时/.test((e && e.message) || '') ? '系统无响应' : ((e && e.code) || (e && e.message) || '未知');
    fails.push('.lnk → ' + why);
  }
  /* 方案2：.vbs（部分环境会拦截脚本文件，作为兜底） */
  try {
    await withTimeout(fs.promises.writeFile(STARTUP_VBS, startupVbsContent(), 'utf8'), STARTUP_TIMEOUT_MS, '写入超时');
    return { ok: true, how: '启动文件夹脚本(.vbs)' };
  } catch (e) {
    const why = /超时/.test((e && e.message) || '') ? '系统无响应' : ((e && e.code) || (e && e.message) || '未知');
    fails.push('.vbs → ' + why);
  }
  return { ok: false, how: '启动文件夹', error: '写入启动文件夹失败（' + fails.join('；') + '）' };
}

/** 卸载开机自启（异步移除启动文件夹里的 .lnk 与 .vbs）。返回 {ok, error} */
async function removeStartupEntry() {
  try {
    for (const f of [STARTUP_LNK, STARTUP_VBS]) {
      await withTimeout(fs.promises.unlink(f).catch((e) => { if (e && e.code !== 'ENOENT') throw e; }),
        STARTUP_TIMEOUT_MS, '访问「启动」文件夹超时');
    }
    return { ok: true };
  } catch (e) {
    const code = (e && e.code) ? ('（' + e.code + '）') : '';
    return { ok: false, error: '移除启动文件夹文件失败' + code + '：' + ((e && e.message) || '未知原因') };
  }
}

/** 开机自启自检：逐项实测并给出可读结论，用于区分「权限不足」与「环境拦截」。
 *  全部使用异步 I/O + 超时，绝不阻塞事件循环。返回结构化诊断结果。 */
async function diagnoseAutostart() {
  const R = {
    identity: {},
    startupDir: { path: STARTUP_DIR, exists: false, writable: false, error: '' },
    entry: { path: STARTUP_LNK, installed: false },
    schtasks: { path: '', available: false, error: '' },
    aclWritable: null,      // 依据 ACL 判断（若能取到）
    verdict: '',            // 面向用户的结论
    canInstall: false,
    advice: [],
  };

  /* 1) 身份与提权状态 */
  try {
    const wd = process.env.USERDOMAIN || '';
    R.identity.user = (wd ? wd + '\\' : '') + (process.env.USERNAME || '(未知)');
  } catch (e) { R.identity.user = '(读取失败)'; }
  R.identity.isAdmin = null;   // 纯 Node 无权查提权，留空由前端/说明判断
  R.identity.note = '开机自启（启动文件夹方式）按 Windows 设计无需管理员权限。';

  /* 2) 启动文件夹：存在性 + 实测可写性（写临时探针后立即删除） */
  try {
    await withTimeout(fs.promises.access(STARTUP_DIR, fs.constants.F_OK), 3000, '访问超时');
    R.startupDir.exists = true;
  } catch (e) {
    R.startupDir.exists = false;
    R.startupDir.error = '目录不存在或不可访问：' + ((e && e.message) || '未知原因');
  }
  if (R.startupDir.exists) {
    /* 分别实测三种文件类型的可写性，用于给出准确结论：
     *   .tmp  → 目录整体是否可写
     *   .lnk  → 首选注册方式（快捷方式，不含脚本，安全软件通常不拦）
     *   .vbs  → 兜底注册方式（部分环境/安全软件会拦截脚本）
     */
    const probe = async (name, data) => {
      const p = path.join(STARTUP_DIR, name);
      try {
        await withTimeout(fs.promises.writeFile(p, data), 3000, '写入超时');
        await fs.promises.unlink(p).catch(() => {});
        return true;
      } catch (e) {
        await fs.promises.unlink(p).catch(() => {});
        return false;
      }
    };
    R.startupDir.tmpWritable = await probe('__xqy_probe__.tmp', 'probe');
    R.startupDir.lnkWritable = await probe('__xqy_probe__.lnk', Buffer.alloc(0x4C));
    R.startupDir.vbsWritable = await probe('__xqy_probe__.vbs', "' probe");
    /* 安装可行性 = lnk 或 vbs 任一可写 */
    R.startupDir.writable = R.startupDir.lnkWritable || R.startupDir.vbsWritable;
    if (!R.startupDir.writable) {
      R.startupDir.error = !R.startupDir.tmpWritable
        ? '目录整体不可写'
        : '目录可写，但 .lnk/.vbs 文件写入被拦截';
    } else if (R.startupDir.lnkWritable) {
      R.startupDir.error = '';
    }
  }
  try { R.entry.installed = fs.existsSync(STARTUP_LNK) || fs.existsSync(STARTUP_VBS); } catch (e) {}

  /* 3) 备用方案 schtasks 可用性（只探测，不实际改系统） */
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
    R.schtasks.path = exe;
    R.schtasks.available = fs.existsSync(exe);
    if (!R.schtasks.available) R.schtasks.error = '未找到 schtasks.exe';
  } catch (e) { R.schtasks.error = (e && e.message) || '未知原因'; }

  /* 4) 结论与建议 */
  if (R.startupDir.writable) {
    R.canInstall = true;
    R.verdict = R.startupDir.lnkWritable
      ? '可以安装：启动文件夹支持 .lnk 快捷方式，将以「快捷方式」方式注册，无需管理员权限。'
      : '可以安装：将以 .vbs 脚本方式注册（无需管理员权限）。';
  } else {
    R.canInstall = !!R.schtasks.available;
    if (R.startupDir.tmpWritable) {
      R.verdict = '目录本身可写，但启动文件夹拒绝写入 .lnk/.vbs 文件 —— 这不是账号权限不足。';
      R.advice.push('典型原因：安全软件/受限运行环境把「启动文件夹里的可执行配置」视为可疑行为并拦截。');
      R.advice.push('可尝试：右键以管理员身份运行「安装开机自启.cmd」（走计划任务方式），或将本目录加入安全软件白名单。');
    } else {
      R.verdict = R.schtasks.available
        ? '启动文件夹不可写，但可改用「计划任务」方式安装（可能需要管理员权限）。'
        : '两种方式当前都不可用，无法完成安装。';
      R.advice.push('若账号对该目录确有完全控制权（文件夹属性→安全可查看），则是运行环境/安全软件拦截，而非权限不足。');
    }
  }
  if (!R.canInstall && R.schtasks.available) R.advice.push('右键以管理员身份运行「安装开机自启.cmd」可走计划任务方式。');
  if (R.entry.installed) R.advice.push('当前已注册开机自启，重启电脑后应自动启动。');
  return R;
}

/** 兜底：schtasks 计划任务方式（异步 + 超时，绝不阻塞事件循环）。
 *  仅在启动文件夹方式失败时使用（例如企业策略禁用用户启动文件夹）。 */
function schtasksAsync(args, okMsg, failMsg) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (obj) => { if (done) return; done = true; resolve(obj); };
    let ch;
    try {
      const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
      ch = spawn(exe, args, { stdio: 'ignore', env: HELPER_ENV, windowsHide: true });
    } catch (e) {
      finish({ ok: false, error: (failMsg || '安装失败') + '\r\n' + ((e && e.message) || '未知原因') });
      return;
    }
    const guard = setTimeout(() => {
      try { ch.kill(); } catch (e) { /* ignore */ }
      finish({ ok: false, error: (failMsg || '安装失败') + '\r\n计划任务程序长时间无响应（可能被安全软件拦截）' });
    }, STARTUP_TIMEOUT_MS);
    ch.on('error', (e) => {
      clearTimeout(guard);
      const c = e && e.code;
      const why = c === 'EPERM' ? '系统拒绝执行计划任务程序（可能被安全软件或权限策略拦截）'
        : c === 'ENOENT' ? '未找到 schtasks.exe'
        : ((e && e.message) || '未知原因');
      finish({ ok: false, error: (failMsg || '安装失败') + '\r\n' + why });
    });
    ch.on('exit', (code) => {
      clearTimeout(guard);
      if (code === 0) finish({ ok: true, how: '计划任务', message: okMsg });
      else finish({ ok: false, error: (failMsg || '安装失败') + '\r\n（schtasks 退出码 ' + code + '）' });
    });
  });
}

/* 隧道状态（cloudflared 由本服务拉起，stdout/stderr 追加写入 TUNNEL_LOG 供解析公网地址） */
const TUNNEL_URL_TIMEOUT_MS = 60 * 1000; // 超过此时间仍拿不到地址即判定为启动失败
let tunChild = null;      // 本进程拉起的 cloudflared 子进程
let tunStartAt = 0;       // 最近一次启动时刻
let tunError = '';        // 最近一次失败原因（可读文案，供前端展示）
let tunManualStop = false;// 是否为手动关闭（区分「手动关闭」与「进程异常退出」）
let tunStarting = false;  // 启动中的并发锁，防止重复点击拉起多个 cloudflared
let restarting = false;   // 服务重启进行中（避免并发点击触发多次重启）
let hubChild = null, hubKind = null, hubStartedAt = null, hubLog = [];
const HUB_LOG_MAX = 200;
function hubPush(line) { hubLog.push(line); if (hubLog.length > HUB_LOG_MAX) hubLog.splice(0, hubLog.length - HUB_LOG_MAX); }
function latestExportInfo() {
  try {
    const dir = path.join(ROOT, '导出结果');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('会员导出_') && f.endsWith('.json')).sort();
    if (!files.length) return null;
    const st = fs.statSync(path.join(dir, files[files.length - 1]));
    return { file: files[files.length - 1], at: st.mtime.toISOString(), stamp: files[files.length - 1].replace('会员导出_', '').replace('.json', '') };
  } catch (e) { return null; }
}
/** 本进程拉起的 cloudflared 是否仍存活（同步判定，不依赖异步回调） */
function tunAlive() {
  if (tunChild && tunChild.pid) {
    try { process.kill(tunChild.pid, 0); return true; } catch (e) { return false; }
  }
  return false;
}
/* tasklist 是 spawnSync（同步阻塞事件循环）。原实现在每次状态轮询里都跑一次，
   实测约 2.6ms/次；更重要的是它是同步调用，会卡住同一 tick 内的其他请求。
   孤儿进程检测无需秒级实时性，按 TTL 缓存即可。 */
const TASKLIST_TTL = 3000;
let tasklistCache = { at: 0, orphan: false };
function hasOrphanTunnel() {
  const now = Date.now();
  if (now - tasklistCache.at < TASKLIST_TTL) return tasklistCache.orphan;
  let orphan = false;
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/FO', 'CSV', '/NH'], { env: HELPER_ENV, encoding: 'utf8', windowsHide: true });
    orphan = /cloudflared/i.test(String((r && r.stdout) || ''));
  } catch (e) { orphan = false; }
  tasklistCache = { at: now, orphan };
  return orphan;
}
/**
 * 隧道当前状态。
 * 修复要点：
 *   1) 原实现用 execFileSyncCompat 的异步回调给 running 赋值，却在同一函数里同步 return，
 *      导致 running 恒为 false（回调还没执行）且结果延迟一拍，前端状态回显错乱；
 *      现改为同步判定：优先看本进程持有的子进程，其次用 spawnSync 的 tasklist 兜底
 *      （覆盖「服务重启后 cloudflared 变成孤儿进程」的情况）。
 *   2) 公网地址从 TUNNEL_LOG 解析——该文件由启动时把 cloudflared 的 stdout/stderr
 *      追加写入，原实现用 stdio:'ignore' 导致日志恒为空、地址永远拿不到。
 * @returns {{running:boolean,url:string,starting:boolean,error:string,startedAt:number}}
 */
function tunnelInfo() {
  const alive = tunAlive();
  const orphan = alive ? false : hasOrphanTunnel();
  const running = alive || orphan;
  let url = '';
  try {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(fs.readFileSync(TUNNEL_LOG, 'utf8'));
    if (m) url = m[0];
  } catch (e) {}
  let error = tunError || '';
  const starting = running && !url && !error;
  /* 进程在跑但迟迟拿不到地址 —— 判定为失败，给出可读原因 */
  if (starting && tunStartAt && Date.now() - tunStartAt > TUNNEL_URL_TIMEOUT_MS) {
    error = '隧道进程已启动，但 60 秒内未取到公网地址。常见原因：网络不通或被防火墙拦截。可查看 .dev\\tunnel.err.log 排查。';
  }
  return { running, url, starting: starting && !error, error, startedAt: tunStartAt || 0 };
}
/* 5.1/跨环境安全的 tasklist 捕获 */
function execFileSyncCompat(cmd, args, onOut) {
  try {
    const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], env: HELPER_ENV });
    let out = '';
    ch.stdout.on('data', (d) => { out += d.toString(); });
    ch.on('exit', () => { if (onOut) onOut(out); });
    ch.on('error', () => { if (onOut) onOut(''); });
  } catch (e) { if (onOut) onOut(''); }
}
function wireHubChild(ch) {
  let buf = '';
  const feed = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) hubPush(line);
    }
  };
  ch.stdout.on('data', feed);
  ch.stderr.on('data', feed);
  /* 同 wireChild：导出子进程 spawn 失败也要兜住，避免未捕获异常搞崩服务端 */
  ch.on('error', (e) => {
    hubPush('[错误] 导出进程启动失败：' + ((e && e.message) || '未知原因'));
    if (hubChild === ch) { hubChild = null; }
  });
}
let hubDataCache = null, hubDataM = 0;
/** 会员统计轻量 sidecar：{ members, orders, covered, stamp, generatedAt }
 *  由 build_viewer.py 在生成查询页数据时一并写出（几 KB）。
 *  存在的意义：控制中心首屏只需要「会员数 / 订单数 / 数据时间」三个标量，
 *  而原实现要先同步解析 4.93MB 的 data.js（其中绝大多数体积是订单详情与分片索引），
 *  才能算出会员数 —— 这让「会员信息」被迫依赖「订单详情」这条更重的链路。
 *  sidecar 由数据生成侧同步产出，与 data.js 同一时刻、同一份数据，口径天然一致；
 *  缺失时自动回退到解析 data.js 的旧路径，保证任何环境下都能显示。 */
const HUB_STAT_FILE = path.join(ROOT, '导出结果', '.hub_stat.json');
let hubStatCache = null, hubStatM = 0;
function hubStat() {
  try {
    const mt = fs.statSync(HUB_STAT_FILE).mtimeMs;
    if (hubStatCache && hubStatM === mt) return hubStatCache;
    const j = JSON.parse(fs.readFileSync(HUB_STAT_FILE, 'utf8'));
    hubStatCache = {
      count: Number(j.members) || 0,
      orders: Number(j.orders) || 0,
      covered: Number(j.covered) || 0,
      stamp: j.stamp || '',
      generatedAt: j.generatedAt || ''
    };
    hubStatM = mt;
    return hubStatCache;
  } catch (e) { return null; }
}
function hubData() {
  /* 优先 sidecar（O(1)）；缺失或异常时才回退解析 4.93MB 的 data.js */
  const s = hubStat();
  if (s) return { count: s.count, stamp: s.stamp, shop: '' };
  try {
    const f = path.join(ROOT, '查询页面', 'data.js');
    const mt = fs.statSync(f).mtimeMs;
    if (hubDataCache && hubDataM === mt) return hubDataCache;
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^window\.MEMBER_DATA=/, '').replace(/;\s*$/, ''));
    hubDataCache = { count: (j.members || []).length, stamp: j.exportStamp || '', shop: j.shop || '' };
    hubDataM = mt;
    return hubDataCache;
  } catch (e) { return hubDataCache || { count: 0, stamp: '', shop: '' }; }
}
async function hubStatus() {
  /* cdpCheck 是唯一的异步项，先启动探测，与下面的同步计算并行推进；
     命中缓存时它立即返回，不产生任何额外等待。 */
  const cdpP = cdpCheck();
  const tun = tunnelInfo();
  const exp = latestExportInfo();
  const ms = hubData();
  /* 订单数一律走 readJsonlStats（增量缓存后稳态约 0.0ms，口径与优化前完全一致）。
     注意：不能用 sidecar 的 orders 替代 —— sidecar 的 17572 来自 build_viewer 的
     order_map（按人去重后的覆盖口径），而 JSONL 的 18241 是逐条累加口径，
     两者本就不同（覆盖 1846 人 vs 1872 行）。替换会让控制中心显示的订单数发生变化。 */
  const js = readJsonlStats();
  let autostart = 'unknown';
  try {
    /* 状态判断：启动文件夹文件存在 → 一定已装；否则查标记文件。
       纯 fs 判断，不调用任何外部命令（schtasks/PowerShell 被限制的环境下也能正常显示）。 */
    autostart = (fs.existsSync(STARTUP_VBS) || fs.existsSync(AUTOSTART_FLAG)) ? 'installed' : 'missing';
  } catch (e) {}
  return {
    service: 'ok',
    cdp: await cdpP,
    schedule: { enabled: schedule.enabled, time: schedule.time, shutdownAfter: schedule.shutdownAfter },
    members: ms.count,
    stamp: ms.stamp,
    orders: js,
    lastExport: exp,
    export: { running: !!hubChild, kind: hubKind, startedAt: hubStartedAt, log: hubLog.slice(-12) },
    tunnel: tun,
    autostart
  };
}


/* ---------------- HTTP ---------------- */
function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (e) { /* 保留原路径 */ }
  try {
    if (!checkAuth(req)) {
      if (p.startsWith('/api/')) { sendJson(res, { error: '需要访问口令' }, 401); return; }
      sendLoginPage(res, '请输入访问口令');
      return;
    }
    const tokQ = u.searchParams ? u.searchParams.get('token') : null;
    if (req.method === 'GET' && tokQ != null && tokQ !== '') {
      if (tokQ === CONSOLE_TOKEN) {
        res.writeHead(302, { 'Set-Cookie': 'xconsole=' + encodeURIComponent(CONSOLE_TOKEN) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000', Location: u.pathname });
        res.end();
      } else { sendLoginPage(res, '口令不正确，请重新输入'); }
      return;
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = '';
      try { html = fs.readFileSync(PAGE_FILE, 'utf8'); } catch (e) { html = '<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif">未找到 操作页面.html</body>'; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    /* ---- 控制中心 ---- */
    if (req.method === 'GET' && (p === '/home' || p === '/home/')) {
      try { const html = fs.readFileSync(HUB_FILE, 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('控制中心文件缺失'); }
      return;
    }
    /* ---- 静态页面：查询页面 目录（data.js 与查询台页面）---- */
    if (req.method === 'GET' && ['/使用说明.html', '/导出流程图.png'].includes(p)) {
      const abs = path.join(ROOT, p.slice(1));
      if (fs.existsSync(abs)) {
        const mime = p.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(abs));
      } else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); }
      return;
    }
    if (req.method === 'GET' && p.startsWith('/查询页面/')) {
      const rel = decodeURIComponent(p.slice(1));
      const abs = path.normalize(path.join(ROOT, rel));
      if (abs.startsWith(path.normalize(ROOT)) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const ext = path.extname(abs).toLowerCase();
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(abs));
      } else { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); }
      return;
    }
    if (req.method === 'GET' && p === '/api/status') { sendJson(res, await statusPayload()); return; }
    if (req.method === 'POST' && p === '/api/start') {
      const body = await readBody(req);
      const sample = Number(body.sample) > 0 ? Number(body.sample) : 0;
      const r = await start(sample);
      sendJson(res, r, r.error ? 409 : 200);
      return;
    }
    if (req.method === 'POST' && p === '/api/stop') { const r = stop(); sendJson(res, r, r.ok ? 200 : 409); return; }
    if (req.method === 'GET' && p === '/api/schedule') { sendJson(res, { ok: true, schedule: { enabled: schedule.enabled, time: schedule.time, shutdownAfter: schedule.shutdownAfter, lastFiredDate: schedule.lastFiredDate } }); return; }
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const t = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(body.time || ''));
      if (!t || +t[1] > 23 || +t[2] > 59) { sendJson(res, { error: '时间格式应为 HH:MM（如 23:00）' }, 400); return; }
      schedule.enabled = !!body.enabled;
      schedule.time = String(+t[1]).padStart(2, '0') + ':' + t[2];
      schedule.shutdownAfter = !!body.shutdownAfter;
      saveSchedule();
      pushLog('定时同步设置已保存：' + (schedule.enabled ? ('每天 ' + schedule.time + (schedule.shutdownAfter ? '，同步后自动关机' : '')) : '已停用'));
      sendJson(res, { ok: true, schedule: { enabled: schedule.enabled, time: schedule.time, shutdownAfter: schedule.shutdownAfter, lastFiredDate: schedule.lastFiredDate } });
      return;
    }
    if (req.method === 'POST' && p === '/api/cancel_shutdown') { sendJson(res, cancelShutdown()); return; }
    if (req.method === 'POST' && p === '/api/rebuild') { sendJson(res, rebuild()); return; }
    if (req.method === 'POST' && p === '/api/cleanup') { cleanupOldData().then((n) => sendJson(res, { ok: true, removed: n })); return; }
    if (req.method === 'POST' && p === '/api/open') {
      const body = await readBody(req);
      const what = body.what === 'folder' ? path.join(ROOT, '导出结果', '订单数据') : path.join(ROOT, '查询页面', 'index.html');
      try { spawn('cmd.exe', ['/c', 'start', '', what], { cwd: ROOT, stdio: 'ignore', detached: true }); } catch (e) { /* ignore */ }
      sendJson(res, { ok: true });
      return;
    }
    /* ---- 控制中心 API ---- */
    if (p === '/api/hub/status' && req.method === 'GET') { sendJson(res, await hubStatus()); return; }
    if (p === '/api/hub/export' && req.method === 'POST') {
      if (child) { sendJson(res, { error: '抓取任务运行中，请稍后再导出' }, 409); return; }
      if (hubChild) { sendJson(res, { error: '已有导出在进行' }, 409); return; }
      const b = await readBody(req);
      const deep = b.mode === 'deep';
      hubKind = deep ? 'deep' : 'quick';
      hubStartedAt = new Date().toISOString();
      hubLog = [];
      hubPush('启动' + (deep ? '完整导出（含详情增量）' : '快速导出（常规+全量字段）'));
      try { fs.writeFileSync(HUB_LOG, ''); } catch (e) {}
      hubChild = spawn(process.execPath, deep ? ['app/export.mjs', '--deep'] : ['app/export.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      wireHubChild(hubChild);
      hubChild.on('exit', (code) => {
        hubPush(code === 0 ? '导出完成。' : '导出进程退出（代码 ' + code + '）');
        hubChild = null; hubKind = null;
      });
      sendJson(res, { ok: true });
      return;
    }
    if (p === '/api/hub/export/stop' && req.method === 'POST') {
      if (!hubChild) { sendJson(res, { error: '没有进行中的导出' }, 409); return; }
      try { hubChild.kill(); } catch (e) {}
      hubPush('已手动停止导出。');
      sendJson(res, { ok: true });
      return;
    }
    if (p === '/api/hub/ensure-debug' && req.method === 'POST') {
      const ok = await ensureDebugApp();
      sendJson(res, { ok, error: ok ? undefined : '未能进入调试模式，请查看操作台日志' }, ok ? 200 : 500);
      return;
    }
    if (p === '/api/hub/tunnel/start' && req.method === 'POST') {
      if (!fs.existsSync(CLOUDFLARED)) { sendJson(res, { error: '未找到 app\\cloudflared.exe，无法开启外网隧道' }, 404); return; }
      if (tunStarting) { sendJson(res, { error: '隧道正在启动中，请勿重复点击' }, 409); return; }
      const tun = tunnelInfo();
      if (tun.running && tun.url) { sendJson(res, { ok: true, url: tun.url, already: true }, 200); return; }
      if (tun.running) { sendJson(res, { ok: true, starting: true, already: true, message: '隧道已在启动中，地址生成需要几秒' }, 200); return; }

      tunStarting = true; tunError = ''; tunManualStop = false; tunStartAt = Date.now();
      try { fs.writeFileSync(TUNNEL_LOG, ''); } catch (e) {}
      let ch = null;
      try {
        /* 关键修复：必须 pipe 并把输出写入 TUNNEL_LOG，公网地址才能被解析出来。
           原实现用 stdio:'ignore'，地址全部丢弃，且未带 HELPER_ENV（精简环境下会静默失败）。 */
        ch = spawn(CLOUDFLARED, ['tunnel', '--url', 'http://127.0.0.1:8791', '--no-autoupdate'],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: HELPER_ENV, windowsHide: true });
      } catch (e) {
        tunStarting = false;
        tunError = '启动隧道进程失败：' + ((e && e.message) || '未知原因');
        sendJson(res, { error: tunError }, 500);
        return;
      }
      tunChild = ch;
      const append = (d) => { try { fs.appendFileSync(TUNNEL_LOG, d.toString()); } catch (e) { /* 日志失败不影响隧道本身 */ } };
      ch.stdout.on('data', append);
      ch.stderr.on('data', append);
      ch.on('error', (e) => {
        tunError = '隧道进程无法运行：' + ((e && e.message) || '未知原因');
        if (tunChild === ch) tunChild = null;
        tunStarting = false;
        pushLog('[错误] 外网隧道启动失败：' + tunError);
      });
      ch.on('exit', (code) => {
        if (tunChild === ch) tunChild = null;
        tunStarting = false;
        if (tunManualStop) return;
        let hadUrl = false;
        try { hadUrl = /trycloudflare\.com/.test(fs.readFileSync(TUNNEL_LOG, 'utf8')); } catch (e) {}
        if (!hadUrl) {
          tunError = '隧道进程已退出（代码 ' + code + '），未能生成公网地址。常见原因：网络不通或被防火墙拦截。';
          pushLog('[错误] 外网隧道：' + tunError);
        }
      });
      /* 启动锁 5 秒后自动释放，避免连点拉起多个进程；真实防重由 tunnelInfo().running 兜底 */
      setTimeout(() => { tunStarting = false; }, 5000);
      sendJson(res, { ok: true, starting: true, message: '隧道启动中，公网地址约需几秒生成' });
      return;
    }
    if (p === '/api/hub/tunnel/stop' && req.method === 'POST') {
      const tun = tunnelInfo();
      if (!tun.running) { try { fs.writeFileSync(TUNNEL_LOG, ''); } catch (e) {} tunError = ''; sendJson(res, { ok: true, already: true }, 200); return; }
      tunManualStop = true;
      /* 先杀本进程持有的子进程，再用 taskkill 兜底清理孤儿进程 */
      try { if (tunChild && tunChild.pid) process.kill(tunChild.pid); } catch (e) { /* 交由 taskkill 兜底 */ }
      try { spawnSync('taskkill', ['/F', '/IM', 'cloudflared.exe'], { stdio: 'ignore', env: HELPER_ENV, windowsHide: true }); } catch (e) {}
      await new Promise((r) => setTimeout(r, 900));
      const after = tunnelInfo();
      if (after.running) {
        sendJson(res, { error: '未能关闭隧道进程（可能被安全软件拦截）。请手动结束 cloudflared.exe。' }, 500);
        return;
      }
      try { fs.writeFileSync(TUNNEL_LOG, ''); } catch (e) {}
      tunChild = null; tunError = ''; tunStartAt = 0;
      sendJson(res, { ok: true, message: '隧道已关闭' });
      return;
    }
    if (p === '/api/hub/tunnel/status' && req.method === 'GET') { sendJson(res, tunnelInfo()); return; }
    if (p === '/api/hub/restart' && req.method === 'POST') {
      /* 重启会中断当前抓取/导出，有任务在跑时拒绝 */
      if (child) { sendJson(res, { error: '抓取任务正在运行，请先暂停后再重启服务' }, 409); return; }
      if (hubChild) { sendJson(res, { error: '会员导出正在运行，请先停止后再重启服务' }, 409); return; }
      if (rebuilding) { sendJson(res, { error: '正在刷新查询页面数据，请稍后再重启服务' }, 409); return; }
      if (restarting) { sendJson(res, { error: '重启已在进行中，请勿重复点击' }, 409); return; }
      restarting = true;
      try {
        const node = process.execPath;
        const script = path.join(ROOT, 'app', 'orders_server.mjs');
        const vbs = path.join(ROOT, '重启服务.vbs');
        if (!fs.existsSync(vbs)) { restarting = false; sendJson(res, { error: '缺少 重启服务.vbs' }, 404); return; }
        /* 用 wscript 拉起「重启服务.vbs」：VBS 内部 WScript.Sleep 3 秒后以窗口隐藏方式(0)
           启动新实例。这样做的好处：
             1) 无控制台窗口（与开机自启同一套 wscript 机制，符合「不弹黑窗」要求）；
             2) wscript.exe 是独立进程，本实例退出后新实例仍存活；
             3) 不依赖 ping/timeout 延时（stdin 重定向时 timeout 会立即失败）。 */
        const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
        const ch = spawn(WSCRIPT, ['//B', '"' + vbs + '"', '"' + node + '"', '"' + script + '"'],
          { cwd: ROOT, detached: true, stdio: 'ignore', env: HELPER_ENV, windowsHide: true });
        ch.on('error', (e) => { restarting = false; pushLog('[错误] 重启服务失败：' + ((e && e.message) || '未知原因')); });
        ch.unref();
        pushLog('服务重启：已安排新实例（无窗口启动），当前实例即将退出。');
        sendJson(res, { ok: true, message: '服务重启中，约 5 秒后自动恢复' });
        setTimeout(() => { try { process.exit(0); } catch (e) { /* ignore */ } }, 400);
      } catch (e) {
        restarting = false;
        sendJson(res, { error: '重启失败：' + ((e && e.message) || '未知原因') }, 500);
      }
      return;
    }
    if (p === '/api/hub/autostart' && req.method === 'POST') {
      const b = await readBody(req);
      const setFlag = (on) => { try { if (on) fs.writeFileSync(AUTOSTART_FLAG, new Date().toISOString()); else fs.unlinkSync(AUTOSTART_FLAG); } catch (e) { /* ignore */ } };

      if (b.action === 'install') {
        /* 优先「启动文件夹」（纯文件读写，无需外部进程/管理员权限）；
           失败再退回 schtasks 计划任务（异步 + 超时，不会阻塞服务）。 */
        const r = await installStartupEntry();
        if (r.ok) {
          setFlag(true);
          sendJson(res, { ok: true, message: '开机自启已安装：登录 Windows 后自动启动', how: r.how });
          return;
        }
        const vbs = path.join(ROOT, '开机自启-操作台服务.vbs');
        if (fs.existsSync(vbs)) {
          const s2 = await schtasksAsync(
            ['/Create', '/F', '/TN', 'XQY-Orders-Console', '/TR', 'wscript.exe "' + vbs + '"', '/SC', 'ONLOGON', '/DELAY', '0000:30', '/RL', 'LIMITED'],
            '开机自启已安装（计划任务方式）', '开机自启安装失败：\r\n启动文件夹 → ' + r.error);
          if (s2.ok) { setFlag(true); sendJson(res, { ok: true, message: s2.message, how: s2.how }); return; }
          sendJson(res, { error: s2.error }, 500);
          return;
        }
        sendJson(res, {
          error: '开机自启安装失败\r\n' + r.error +
            '\r\n可点击「自检」查看详细诊断；若自检显示目录可写，通常是当前运行环境（沙箱/安全软件）拦截写入脚本，请在本机双击「打开订单抓取操作台.cmd」启动服务后再试。'
        }, 500);
        return;
      }
      if (b.action === 'remove') {
        const r = await removeStartupEntry();
        if (r.ok) { setFlag(false); sendJson(res, { ok: true, message: '开机自启已移除' }); return; }
        sendJson(res, { error: '移除失败\r\n' + r.error }, 500);
        return;
      }
      sendJson(res, { error: '未知操作' }, 400);
      return;
    }
    /* 开机自启自检：实测目录可写性/已安装状态/schtasks 可用性，给出可读结论 */
    if (p === '/api/hub/autostart/diag' && req.method === 'GET') {
      try { sendJson(res, { ok: true, diag: await diagnoseAutostart() }); }
      catch (e) { sendJson(res, { ok: false, error: (e && e.message) || String(e) }, 500); }
      return;
    }

    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { error: (e && e.message) || String(e) }, 500);
  }
});

/* ---------------- 启动 ---------------- */
loadSchedule();
setInterval(() => { schedulerTick().catch((e) => { schedBusy = false; pushLog('[错误] 定时任务异常：' + e.message); }); }, 20000);
setTimeout(() => { cleanupOldData(); }, 8000); // 启动后自动检查一次过时数据
const CONSOLE_TOKEN = loadToken();
server.listen(PORT, '127.0.0.1', () => {
  pushLog('操作台服务已启动：http://127.0.0.1:' + PORT + '/');
  console.log('操作台服务已启动: http://127.0.0.1:' + PORT + '/');
  /* 端口先监听，统计基线随后在后台预热。
     关键顺序：原实现先跑 loadBaseStats() + readJsonlStats()（约 1.2s，其中 JSONL
     首次全量解析 1.08s）再 server.listen，导致这 1.2s 内连接全部被拒，
     Electron 主进程 portOpen() 反复失败、waitServer 每 400ms 重试，
     白白多花一个轮询周期的启动时间。移到监听之后，首个请求即可被受理。
     用 setTimeout 而非 setImmediate：让出当前 tick，先把首屏请求处理完再预热。 */
  setTimeout(ensureWarm, 200);
});
server.on('error', (e) => {
  const busy = e && e.code === 'EADDRINUSE';
  console.error(busy ? '端口 8791 已被占用（可能已有操作台实例在运行），本次自启退出。' : ('服务异常：' + ((e && e.message) || e)));
  process.exit(busy ? 0 : 1);
});
process.on('exit', () => {
  try {
    if (!fs.existsSync(LOCK_PATH)) return;
    const lp = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (lp > 0) { try { process.kill(lp, 0); return; } catch (e) { /* 进程已死，可清 */ } }
    clearLock();
  } catch (e) { /* ignore */ }
});
