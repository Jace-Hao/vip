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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const OUT_DIR = path.join(ROOT, '导出结果', '订单数据');
const PAGE_FILE = path.join(ROOT, '操作页面.html');
const LOCK_PATH = path.join(OUT_DIR, '.orders_run.lock');
const JSONL_PATH = path.join(OUT_DIR, '.orders_results.jsonl');
const LOG_MAX = 500;
const SCHEDULE_FILE = path.join(ROOT, '.sync_schedule.json');
const APP_EXE = 'D:\\Blending_Release-6.1.17\\xygjwinapp.exe';
const SHUTDOWN_DELAY = 120; // 同步完成后延迟关机秒数（期间可取消）

let child = null;
let childKind = null; // deep | orders
let phase = 'idle';   // idle | deep | orders | paused | done | failed
let startedAt = null;
let lastExit = null;
let stopReq = false;
let rebuilding = false;
let logBuf = [];
let baseStats = null;   // { members, withOrders, ordersSum, exportStamp }
let baseDone = 0;       // 启动抓取时 jsonl 已完成人数
let baseOrders = 0;     // 启动抓取时 jsonl 已有订单数
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

function readJsonlStats() {
  try {
    if (!fs.existsSync(JSONL_PATH)) return { members: 0, orders: 0 };
    let members = 0, orders = 0;
    for (const ln of fs.readFileSync(JSONL_PATH, 'utf8').split(/\r?\n/)) {
      if (!ln) continue;
      try { const o = JSON.parse(ln); if (o && o.uid != null) { members++; orders += (o.orderCount != null ? Number(o.orderCount) : ((o.orders || []).length)); } } catch (e) { /* ignore */ }
    }
    return { members, orders };
  } catch (e) { return { members: 0, orders: 0 }; }
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

/* 确保洗衣管家以调试模式运行；必要时自动重启软件 */
async function ensureDebugApp() {
  if (await cdpOk()) return true;
  pushLog('调试端口未就绪，自动重启洗衣管家（调试模式）...');
  await new Promise((resolve) => { const ch = spawn('taskkill', ['/F', '/IM', 'xygjwinapp.exe'], { stdio: 'ignore' }); ch.on('exit', resolve); ch.on('error', resolve); });
  await new Promise((r) => setTimeout(r, 2000));
  if (!fs.existsSync(APP_EXE)) { pushLog('[错误] 找不到洗衣管家主程序：' + APP_EXE); return false; }
  try { spawn('cmd.exe', ['/c', 'start', '', APP_EXE, '--remote-debugging-port=9222'], { cwd: path.dirname(APP_EXE), stdio: 'ignore', detached: true }); } catch (e) { pushLog('[错误] 启动洗衣管家失败：' + e.message); return false; }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await cdpOk(1500)) { pushLog('洗衣管家已进入调试模式。'); return true; }
  }
  pushLog('[错误] 等待洗衣管家调试端口超时（90 秒）。');
  return false;
}

function doShutdown() {
  if (shutdownPending) return;
  shutdownPending = { since: Date.now() };
  pushLog('⚡ 同步完成：系统将在 ' + SHUTDOWN_DELAY + ' 秒后自动关机（可在本页面点「取消关机」）。');
  try { const ch = spawn('shutdown', ['/s', '/t', String(SHUTDOWN_DELAY), '/c', '订单数据同步完成，系统即将关机'], { stdio: 'ignore', detached: true }); ch.on('error', () => {}); } catch (e) { pushLog('[错误] 关机命令执行失败：' + e.message); shutdownPending = null; }
}

function cancelShutdown() {
  if (!shutdownPending) return { error: '当前没有待执行的关机' };
  try { const ch = spawn('shutdown', ['/a'], { stdio: 'ignore' }); ch.on('error', () => {}); } catch (e) { /* ignore */ }
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
    const r = start(0);
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
    const ch = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
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
  const args = kind === 'deep' ? ['app/export.mjs', '--deep'] : ['app/fetch_orders.mjs', '--all'];
  childKind = kind;
  phase = kind;
  child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  pushLog(kind === 'deep' ? '阶段1：会员详情增量更新已启动' : '阶段2：订单全量抓取已启动');
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
      const wantShutdown = scheduleTriggered && schedule.shutdownAfter;
      scheduleTriggered = false;
      cleanupOldData().then(() => {
        const r2 = rebuild(wantShutdown);
        if (r2 && r2.ok) pushLog('正在自动刷新查询页面数据...');
        else if (wantShutdown) doShutdown();
      });
    }
  });
}

function start(sample) {
  if (child) return { error: '已有任务在运行' };
  stopReq = false; lastExit = null;
  state = { progress: { done: 0, total: 0, current: '', memberOrders: 0 }, compare: null, deepProgress: null, cumulative: null, etaMin: null, totalWithOrders: state.totalWithOrders, ordersThisRun: 0, lastError: null };
  const js = readJsonlStats();
  baseDone = js.members; baseOrders = js.orders;
  clearLock();
  startedAt = new Date().toISOString();
  const args = sample > 0 ? ['app/fetch_orders.mjs', '--sample=' + sample] : ['app/fetch_orders.mjs', '--all'];
  spawnPhase('deep');
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
  const ch = spawn(exe, ['app/build_viewer.py'], { cwd: ROOT, stdio: 'ignore' });
  ch.on('exit', (code) => {
    rebuilding = false;
    pushLog(code === 0 ? '查询页面数据已刷新' : '查询页面数据刷新失败');
    if (thenShutdown) doShutdown();
  });
  return { ok: true };
}

/* ---------------- 状态 ---------------- */
async function cdpCheck() {
  try { await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(1500) }); return 'ok'; } catch (e) { return '不可用'; }
}

async function statusPayload() {
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
    etaMin: state.etaMin,
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
  const p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = '';
      try { html = fs.readFileSync(PAGE_FILE, 'utf8'); } catch (e) { html = '<!DOCTYPE html><meta charset="utf-8"><body style="font-family:sans-serif">未找到 操作页面.html</body>'; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && p === '/api/status') { sendJson(res, await statusPayload()); return; }
    if (req.method === 'POST' && p === '/api/start') {
      const body = await readBody(req);
      const sample = Number(body.sample) > 0 ? Number(body.sample) : 0;
      const r = start(sample);
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
    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    sendJson(res, { error: (e && e.message) || String(e) }, 500);
  }
});

/* ---------------- 启动 ---------------- */
loadSchedule();
setInterval(() => { schedulerTick().catch((e) => { schedBusy = false; pushLog('[错误] 定时任务异常：' + e.message); }); }, 20000);
setTimeout(() => { cleanupOldData(); }, 8000); // 启动后自动检查一次过时数据
baseStats = loadBaseStats();
const js0 = readJsonlStats();
baseDone = js0.members; baseOrders = js0.orders;
server.listen(PORT, '127.0.0.1', () => {
  pushLog('操作台服务已启动：http://127.0.0.1:' + PORT + '/');
  console.log('操作台服务已启动: http://127.0.0.1:' + PORT + '/');
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
