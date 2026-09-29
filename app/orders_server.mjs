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
const APP_EXE = 'D:\\Blending_Release-6.1.17\\xygjwinapp.exe';
const SHUTDOWN_DELAY = 120; // 同步完成后延迟关机秒数（期间可取消）

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
    const ch = spawn('tasklist', ['/FI', 'IMAGENAME eq xygjwinapp.exe', '/FO', 'CSV', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'], env: HELPER_ENV });
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
  await new Promise((resolve) => { const ch = spawn(PWSH, ['-NoProfile', '-Command', 'Stop-Process -Name xygjwinapp -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore', env: HELPER_ENV }); ch.on('exit', resolve); ch.on('error', resolve); });
  for (let i = 0; i < 10 && !killed; i++) { await nap(1000); if ((await appProcCount()) === 0) killed = true; }
  if (!killed) {
    pushLog('PowerShell 强制结束未生效，改用 taskkill ...');
    const rc = await new Promise((resolve) => { const ch = spawn('taskkill', ['/F', '/T', '/IM', 'xygjwinapp.exe'], { stdio: 'ignore', env: HELPER_ENV }); ch.on('exit', (c) => resolve(c)); ch.on('error', () => resolve(-1)); });
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
    const ch = spawn(SHUTDOWN_EXE, ['/s', '/t', String(SHUTDOWN_DELAY), '/c', '订单数据同步完成，系统即将关机'], { stdio: 'ignore', detached: true, env: SHUTDOWN_ENV });
    ch.on('error', (e) => { pushLog('[错误] 关机命令启动失败：' + e.message); shutdownPending = null; });
    ch.on('exit', (code) => { if (code !== 0) { pushLog('[错误] 关机命令执行失败（代码 ' + code + '），已取消本次自动关机。'); shutdownPending = null; } });
  } catch (e) { pushLog('[错误] 关机命令执行失败：' + e.message); shutdownPending = null; }
}

function cancelShutdown() {
  if (!shutdownPending) return { error: '当前没有待执行的关机' };
  try { const ch = spawn(SHUTDOWN_EXE, ['/a'], { stdio: 'ignore', env: SHUTDOWN_ENV }); ch.on('error', () => {}); } catch (e) { /* ignore */ }
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
  /* 手动启动同样确保洗衣管家处于调试模式（未开/未带端口时自动重启软件） */
  const dbg = await ensureDebugApp();
  if (!dbg) return { error: '洗衣管家未能进入调试模式，请手动完全退出软件后，用「以调试模式启动洗衣管家.cmd」重开再试' };
  stopReq = false; lastExit = null;
  state = { progress: { done: 0, total: 0, current: '', memberOrders: 0 }, compare: null, deepProgress: null, cumulative: null, etaMin: null, totalWithOrders: state.totalWithOrders, ordersThisRun: 0, lastError: null };
  const js = readJsonlStats();
  baseDone = js.members; baseOrders = js.orders;
  clearLock();
  startedAt = new Date().toISOString();
  const args = sample > 0 ? ['app/fetch_orders.mjs', '--sample=' + sample] : ['app/fetch_orders.mjs', '--all'];
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

/* ---------------- 收衣系统（本地化收银） ---------------- */
const SHOP_DIR = path.join(ROOT, '收衣数据');
const SHOP_ORDERS = path.join(SHOP_DIR, 'orders.json');
const SHOP_LOCAL = path.join(SHOP_DIR, 'members_local.json');
const SHOP_LEDGER = path.join(SHOP_DIR, 'ledger.jsonl');
const SHOP_SEQ = path.join(SHOP_DIR, 'seq.json');
function shopRead(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function shopWrite(f, obj) { try { fs.mkdirSync(SHOP_DIR, { recursive: true }); } catch (e) {} const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); try { fs.renameSync(tmp, f); } catch (e) { fs.writeFileSync(f, JSON.stringify(obj)); } }
function shopLedger(e) { try { fs.mkdirSync(SHOP_DIR, { recursive: true }); fs.appendFileSync(SHOP_LEDGER, JSON.stringify(e) + '\n'); } catch (err) {} }
function shopSeq(prefix) { const all = shopRead(SHOP_SEQ, {}); const k = prefix + todayStr().replace(/-/g, ''); all[k] = (all[k] || 0) + 1; shopWrite(SHOP_SEQ, all); return k + ('000' + all[k]).slice(-3); }

let memberCache = null, memberCacheM = 0;
function baseMembers() {
  try {
    const f = path.join(ROOT, '查询页面', 'data.js');
    const mt = fs.statSync(f).mtimeMs;
    if (memberCache && memberCacheM === mt) return memberCache;
    const raw = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(raw.replace(/^window\.MEMBER_DATA=/, '').replace(/;\s*$/, ''));
    const arr = (j.members || []).map((m) => ({ uid: String(m.uid), name: m.name || '', py: (m.py || '').toLowerCase(), phone: m.phone || '', cardnum: m.cardnum || '', level: m.vip_name || m.vipname || '', baseBalance: (Number(m.balance) || 0) / 100, cardBal: (Number(m.cardrmb) || 0) / 100, onum: Number(m.onum) || 0, local: false }));
    memberCache = { shop: j.shop || '', stamp: j.exportStamp || '', members: arr };
    memberCacheM = mt;
    return memberCache;
  } catch (e) { return memberCache || { shop: '', stamp: '', members: [] }; }
}
function localStore() { const L = shopRead(SHOP_LOCAL, null); return (L && typeof L === 'object') ? L : { deltas: {}, locals: {}, edits: {} }; }
function saveLocal(L) { shopWrite(SHOP_LOCAL, L); }
function shopMembers(kw) {
  const L = localStore();
  const base = baseMembers();
  let arr = base.members.map((m) => {
    const ed = L.edits[m.uid] || {};
    return { uid: m.uid, name: ed.name || m.name, py: m.py, phone: ed.phone || m.phone, cardnum: m.cardnum, level: ed.level || m.level, baseBalance: m.baseBalance, cardBal: m.cardBal, onum: m.onum, local: false, delta: L.deltas[m.uid] || 0, balance: m.baseBalance + (L.deltas[m.uid] || 0) };
  });
  for (const uid of Object.keys(L.locals || {})) {
    const lm = L.locals[uid];
    arr.push({ uid: uid, name: lm.name || '', py: (lm.name || '').toLowerCase(), phone: lm.phone || '', cardnum: '', level: lm.level || '散客', baseBalance: lm.balance0 || 0, cardBal: 0, onum: 0, local: true, delta: L.deltas[uid] || 0, balance: (lm.balance0 || 0) + (L.deltas[uid] || 0) });
  }
  if (kw) { kw = String(kw).toLowerCase(); arr = arr.filter((m) => { const nm = String(m.name || '').toLowerCase(), py = String(m.py || ''), ph = String(m.phone || ''), cd = String(m.cardnum || ''); return nm.includes(kw) || py.includes(kw) || ph.includes(kw) || cd.includes(kw); }); }
  return { shop: base.shop, stamp: base.stamp, members: arr };
}
function balanceOf(uid) { const ms = shopMembers().members; const m = ms.filter((x) => x.uid === String(uid))[0]; return m ? m.balance : null; }
function applyDelta(uid, d) { const L = localStore(); L.deltas[uid] = (L.deltas[uid] || 0) + d; saveLocal(L); }
function shopOrders() { return shopRead(SHOP_ORDERS, []); }
function saveOrders(a) { shopWrite(SHOP_ORDERS, a); }
function orderPieces(o) { let n = 0; (o.items || []).forEach((i) => { n += Number(i.qty) || 0; }); return n; }
const SHOP_STATUS = { received: '已收衣', washing: '洗涤中', done: '已完成', picked: '已取件' };
function shopStats() {
  const orders = shopOrders();
  const k = todayStr();
  const month = k.slice(0, 7);
  const calc = (list) => { let bills = list.length, pieces = 0, revenue = 0, due = 0; const payMap = {}; list.forEach((o) => { pieces += orderPieces(o); if (o.payStatus !== 'due') revenue += o.total; else due += o.total; payMap[o.pay] = (payMap[o.pay] || 0) + o.total; }); return { bills, pieces, revenue: Math.round(revenue * 100) / 100, due: Math.round(due * 100) / 100, payMap }; };
  const today = calc(orders.filter((o) => (o.no || '').indexOf('R' + k.replace(/-/g, '')) === 0));
  const monthL = calc(orders.filter((o) => (o.no || '').indexOf('R' + month.replace(/-/g, '')) === 0));
  let reToday = 0, reMonth = 0;
  try { for (const ln of fs.readFileSync(SHOP_LEDGER, 'utf8').split(/\r?\n/)) { if (!ln) continue; try { const e = JSON.parse(ln); if (e.type === '充值') { const d = (e.ts || '').slice(0, 10); if (d === k) reToday += (e.amount || 0) + (e.bonus || 0); if (d && d.slice(0, 7) === month) reMonth += (e.amount || 0) + (e.bonus || 0); } } catch (er) {} } } catch (e) {}
  const openCount = orders.filter((o) => o.status !== 'picked').length;
  return { today, month: monthL, rechargeToday: Math.round(reToday * 100) / 100, rechargeMonth: Math.round(reMonth * 100) / 100, openCount };
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
    /* ---- 静态页面：/shop（收衣系统）与 查询页面 / 收衣页面 目录 ---- */
    if (req.method === 'GET' && (p === '/shop' || p === '/shop/')) {
      const f = path.join(ROOT, '收衣页面', 'index.html');
      try { const html = fs.readFileSync(f, 'utf8'); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); } catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('收衣页面文件缺失'); }
      return;
    }
    if (req.method === 'GET' && (p.startsWith('/查询页面/') || p.startsWith('/收衣页面/'))) {
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
    /* ---- 收衣系统 API ---- */
    if (p === '/api/shop/members' && req.method === 'GET') { sendJson(res, shopMembers(u.searchParams.get('kw') || '')); return; }
    if (p === '/api/shop/orders' && req.method === 'GET') {
      const kw = (u.searchParams.get('kw') || '').toLowerCase();
      const st = u.searchParams.get('status') || '';
      let arr = shopOrders();
      if (st) arr = arr.filter((o) => o.status === st);
      if (kw) arr = arr.filter((o) => ((o.name || '') + ' ' + (o.phone || '') + ' ' + o.no).toLowerCase().includes(kw));
      sendJson(res, { orders: arr.slice(0, 300), statusText: SHOP_STATUS });
      return;
    }
    if (p === '/api/shop/order/create' && req.method === 'POST') {
      const b = await readBody(req);
      if (!Array.isArray(b.items) || !b.items.length) { sendJson(res, { error: '衣物明细为空' }, 400); return; }
      let sub = 0, pieces = 0;
      for (const it of b.items) { const q = Number(it.qty) || 0, pr = Number(it.price) || 0; if (q <= 0) { sendJson(res, { error: '数量必须大于 0' }, 400); return; } sub += q * pr; pieces += q; }
      const disc = Number(b.discount) || 1, rnd = Number(b.round) || 0;
      const total = Math.max(0, Math.round((sub * disc - rnd) * 100) / 100);
      const uid = String(b.uid || '');
      const pay = String(b.pay || '现金');
      let balanceAfter = null;
      if (pay === '余额') {
        const bal = uid ? balanceOf(uid) : null;
        if (bal == null) { sendJson(res, { error: '会员不存在，无法余额支付' }, 400); return; }
        if (bal < total) { sendJson(res, { error: '余额不足（当前 ￥' + bal.toFixed(2) + '，应收 ￥' + total.toFixed(2) + '）' }, 400); return; }
      }
      const o = {
        no: shopSeq('R'), ts: new Date().toISOString(),
        uid: uid, name: b.name || '', phone: b.phone || '', level: b.level || '',
        items: b.items, pieces, discount: disc, round: rnd, total, pay,
        payStatus: pay === '挂账' ? 'due' : 'paid',
        pickup: b.pickup || '', note: b.note || '',
        status: 'received', balanceAfter: null,
      };
      if (pay === '余额') { applyDelta(uid, -total); o.balanceAfter = balanceOf(uid); shopLedger({ ts: o.ts, uid: uid, name: b.name || '', type: '消费', amount: -total, pay: '余额', no: o.no }); }
      const arr = shopOrders(); arr.unshift(o); saveOrders(arr);
      sendJson(res, { ok: true, order: o });
      return;
    }
    if (p === '/api/shop/order/status' && req.method === 'POST') {
      const b = await readBody(req);
      const arr = shopOrders(); const o = arr.filter((x) => x.no === b.no)[0];
      if (!o) { sendJson(res, { error: '订单不存在' }, 404); return; }
      const flow = { received: ['washing', 'done', 'picked'], washing: ['done', 'picked'], done: ['picked'], picked: [] };
      if (!(flow[o.status] || []).includes(b.status)) { sendJson(res, { error: '不允许的状态流转：' + (SHOP_STATUS[o.status] || o.status) + ' → ' + (SHOP_STATUS[b.status] || b.status) }, 400); return; }
      if (b.status === 'picked' && o.payStatus === 'due') { sendJson(res, { error: '该单为挂账单，请先结算收款' }, 400); return; }
      o.status = b.status; if (b.status === 'picked') o.pickedAt = new Date().toISOString();
      saveOrders(arr);
      sendJson(res, { ok: true, order: o });
      return;
    }
    if (p === '/api/shop/order/settle' && req.method === 'POST') {
      const b = await readBody(req);
      const arr = shopOrders(); const o = arr.filter((x) => x.no === b.no)[0];
      if (!o) { sendJson(res, { error: '订单不存在' }, 404); return; }
      if (o.payStatus !== 'due') { sendJson(res, { error: '该单已结清' }, 400); return; }
      const pay = String(b.pay || '现金');
      if (pay === '余额') {
        const bal = o.uid ? balanceOf(o.uid) : null;
        if (bal == null) { sendJson(res, { error: '会员不存在，无法余额支付' }, 400); return; }
        if (bal < o.total) { sendJson(res, { error: '余额不足（当前 ￥' + bal.toFixed(2) + '）' }, 400); return; }
        applyDelta(o.uid, -o.total); o.balanceAfter = balanceOf(o.uid);
        shopLedger({ ts: new Date().toISOString(), uid: o.uid, name: o.name || '', type: '消费', amount: -o.total, pay: '余额', no: o.no });
      }
      o.pay = pay; o.payStatus = 'paid'; o.settledAt = new Date().toISOString();
      if (o.status !== 'picked') { o.status = 'picked'; o.pickedAt = o.settledAt; }
      saveOrders(arr);
      sendJson(res, { ok: true, order: o });
      return;
    }
    if (p === '/api/shop/recharge' && req.method === 'POST') {
      const b = await readBody(req);
      const uid = String(b.uid || '');
      const amount = Math.round((Number(b.amount) || 0) * 100) / 100;
      const bonus = Math.round((Number(b.bonus) || 0) * 100) / 100;
      if (amount <= 0) { sendJson(res, { error: '充值金额必须大于 0' }, 400); return; }
      if (balanceOf(uid) == null) { sendJson(res, { error: '会员不存在' }, 404); return; }
      applyDelta(uid, amount + bonus);
      const no = shopSeq('C');
      const entry = { ts: new Date().toISOString(), uid: uid, name: b.name || '', type: '充值', amount, bonus, pay: b.pay || '现金', no };
      shopLedger(entry);
      sendJson(res, { ok: true, no, balance: balanceOf(uid) });
      return;
    }
    if (p === '/api/shop/member/create' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) { sendJson(res, { error: '姓名不能为空' }, 400); return; }
      const uid = 'L' + Date.now();
      const L = localStore();
      L.locals[uid] = { name, phone: String(b.phone || ''), level: String(b.level || '散客'), balance0: Math.round((Number(b.balance0) || 0) * 100) / 100, createdAt: new Date().toISOString() };
      saveLocal(L);
      if (L.locals[uid].balance0 > 0) { shopLedger({ ts: new Date().toISOString(), uid, name, type: '充值', amount: L.locals[uid].balance0, bonus: 0, pay: '建档充值', no: shopSeq('C') }); }
      sendJson(res, { ok: true, uid, balance: balanceOf(uid) });
      return;
    }
    if (p === '/api/shop/member/update' && req.method === 'POST') {
      const b = await readBody(req);
      const uid = String(b.uid || '');
      if (balanceOf(uid) == null && uid[0] !== 'L') { sendJson(res, { error: '会员不存在' }, 404); return; }
      const L = localStore();
      L.edits[uid] = Object.assign(L.edits[uid] || {}, { name: b.name !== undefined ? String(b.name) : (L.edits[uid] || {}).name, phone: b.phone !== undefined ? String(b.phone) : (L.edits[uid] || {}).phone, level: b.level !== undefined ? String(b.level) : (L.edits[uid] || {}).level });
      if (uid[0] === 'L' && L.locals[uid]) { if (b.name !== undefined) L.locals[uid].name = String(b.name); if (b.phone !== undefined) L.locals[uid].phone = String(b.phone); if (b.level !== undefined) L.locals[uid].level = String(b.level); }
      saveLocal(L);
      sendJson(res, { ok: true });
      return;
    }
    if (p === '/api/shop/ledger' && req.method === 'GET') {
      const uid = u.searchParams.get('uid') || '';
      let arr = [];
      try { for (const ln of fs.readFileSync(SHOP_LEDGER, 'utf8').split(/\r?\n/)) { if (!ln) continue; try { const e = JSON.parse(ln); if (!uid || e.uid === uid) arr.push(e); } catch (er) {} } } catch (e) {}
      sendJson(res, { ledger: arr.slice(-300).reverse(), total: arr.length });
      return;
    }
    if (p === '/api/shop/stats' && req.method === 'GET') { sendJson(res, shopStats()); return; }
    if (p === '/api/shop/bootstrap' && req.method === 'GET') {
      const ms = shopMembers();
      sendJson(res, { shop: ms.shop, stamp: ms.stamp, count: ms.members.length, stats: shopStats() });
      return;
    }
    if (p === '/api/shop/import' && req.method === 'POST') {
      const b = await readBody(req);
      const inc = Array.isArray(b.orders) ? b.orders : [];
      const arr = shopOrders();
      const have = new Set(arr.map((o) => o.no));
      let n = 0;
      for (const o of inc) { if (o && o.no && !have.has(o.no)) { arr.push(Object.assign({ status: o.status === 'picked' ? 'picked' : (o.status || 'received'), payStatus: o.pay === '挂账' ? 'due' : 'paid' }, o)); n++; } }
      arr.sort((x, y) => (y.ts || '').localeCompare(x.ts || ''));
      saveOrders(arr);
      sendJson(res, { ok: true, imported: n, total: arr.length });
      return;
    }
    if (p === '/api/shop/export' && req.method === 'GET') {
      const rows = [['单号','时间','会员','电话','级别','件数','折扣','抹零','应收','支付','结算','状态','取件日期','备注']];
      for (const o of shopOrders()) rows.push([o.no, o.ts, o.name, o.phone, o.level, orderPieces(o), o.discount, o.round, o.total, o.pay, o.payStatus === 'due' ? '挂账' : '已结', SHOP_STATUS[o.status] || o.status, o.pickup, o.note]);
      const csv = '\ufeff' + rows.map((r) => r.map((c) => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=orders.csv', 'Cache-Control': 'no-store' });
      res.end(csv);
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
