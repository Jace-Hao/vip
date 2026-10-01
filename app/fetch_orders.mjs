#!/usr/bin/env node
/* ============================================================
 * 洗衣管家 · 会员订单数据抓取
 * ------------------------------------------------------------
 * 拉取指定会员的全部订单列表（基础信息：订单号/状态/金额/时间/架号），
 * 不再逐单拉取衣物明细/照片/支付等详情，输出：
 *   - 订单_<姓名>_<uid>_<时间>.json        完整数据（只读抓取）
 *   - 订单试点预览_<姓名>_<uid>_<时间>.html 可视化预览页（双击打开）
 *
 * 只读操作：仅调用查询接口，不修改任何数据。
 * 用法：node fetch_orders.mjs --uid=25190368 [--out=目录] [--no-html]
 *       node fetch_orders.mjs --sample=50   （批量抽样：均匀抽取 N 个有订单的会员）
 *       node fetch_orders.mjs --all         （全量：所有有订单的会员）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CDP_BASE = 'http://127.0.0.1:9222';

let UID = '';
let SAMPLE = 0;
let OUT_DIR = path.join(ROOT, '导出结果', '订单数据');
let MAKE_HTML = true;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--uid=')) UID = String(a.slice('--uid='.length)).trim();
  else if (a.startsWith('--sample=')) SAMPLE = Math.max(1, parseInt(a.slice('--sample='.length), 10) || 0);
  else if (a === '--all') SAMPLE = 1000000000;
  else if (a.startsWith('--out=')) OUT_DIR = path.resolve(a.slice('--out='.length));
  else if (a === '--no-html') MAKE_HTML = false;
}
if (!UID && SAMPLE <= 0) { console.error('用法: node fetch_orders.mjs --uid=<会员ID> 或 --sample=<N> [--out=目录] [--no-html]'); process.exit(1); }

/* 单实例锁 */
const LOCK_PATH = path.join(OUT_DIR, '.orders_run.lock');
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
      if (alive) { console.error('[错误] 已有订单抓取任务在运行（PID ' + pid + '）。可在操作台点击"暂停"停止后重试。'); return false; }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch (e) { console.error('[错误] 锁处理失败：' + (e && e.message)); return false; }
}
process.on('exit', function () {
  try { if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH); } catch (e) { /* ignore */ }
});

function memberSig(m) {
  const o = {};
  for (const k of Object.keys(m).sort()) {
    if (k === 'ip') continue;
    o[k] = m[k];
  }
  return createHash('md5').update(JSON.stringify(o)).digest('hex');
}

async function waitLong(seconds, reason) {
  console.log(`      [提示] ${reason}；等待 ${seconds} 秒后自动继续...`);
  const step = 10;
  for (let waited = 0; waited < seconds; waited += step) {
    await sleep(Math.min(step, seconds - waited) * 1000);
    const elapsed = waited + step;
    const remain = seconds - elapsed;
    if (remain > 0) console.log(`        ⏳ 剩余约 ${remain} 秒 ...`);
  }
  console.log(`        ✅ 等待结束，继续执行`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 追加写入 jsonl 并强制刷盘，确保 kill/断电等异常退出不丢已抓数据 */
function appendJsonlSync(filePath, content) {
  fs.appendFileSync(filePath, content, 'utf8');
  try { const fd = fs.openSync(filePath, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch (e) { /* fsync 失败不阻塞 */ }
}

/* 订单列表签名 */
function listSig(rows, rackMap) {
  const mini = rows.map((r) => [r.orderid, r.wstatus, r.trmb, r.ctime, (rackMap && rackMap.get(String(r.orderid))) || r.poscode || '', r.gtime, r.pctime]);
  return createHash('md5').update(JSON.stringify(mini)).digest('hex');
}

function stamp() { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
function fmtYuan(cents) { const n = Number(cents); return isFinite(n) ? (n / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- CDP ---------------- */
async function findTarget() {
  let list;
  try {
    const r = await fetch(CDP_BASE + '/json/list', { signal: AbortSignal.timeout(6000) });
    list = await r.json();
  } catch (e) {
    console.error('[错误] 无法连接洗衣管家调试端口(127.0.0.1:9222)，请确认软件正在运行且已登录。');
    process.exit(1);
  }
  const pages = (list || []).filter((t) => t.type === 'page' && typeof t.url === 'string');
  const app = pages.find((t) => t.url.startsWith('xy://') && t.url.includes('/main/')) || pages.find((t) => t.url.startsWith('xy://'));
  if (!app) { console.error('[错误] 未找到洗衣管家页面。'); process.exit(1); }
  return app;
}

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onErr = (e) => reject(new Error('调试端口连接失败: ' + ((e && e.message) || e)));
      ws.addEventListener('open', () => { ws.removeEventListener('error', onErr); resolve(); });
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('message', (ev) => {
        let obj; try { obj = JSON.parse(ev.data); } catch (e) { return; }
        if (obj.id && this.pending.has(obj.id)) { const p = this.pending.get(obj.id); this.pending.delete(obj.id); p.resolve(obj); }
      });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve) => { const id = ++this.id; this.pending.set(id, { resolve }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression, timeoutMs = 30000) {
    let timer = null;
    try {
      const res = await Promise.race([
        this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('页面执行超时')), timeoutMs); }),
      ]);
      const r = res.result || {};
      if (r.exceptionDetails) throw new Error('页面脚本异常: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200));
      const payload = r.result || {};
      return payload.value;
    } finally { if (timer) clearTimeout(timer); }
  }
  close() { try { this.ws && this.ws.close(); } catch (e) { /* ignore */ } }
}

/* ---------------- 页面内接口调用 ---------------- */
function callExpr(params, tmo) {
  return `new Promise(function(resolve){
    var root = document.querySelector('.app').__vue__;
    if (!root || !root.$request) { resolve('{"__err":"no-root"}'); return; }
    var t = setTimeout(function(){ resolve('{"__timeout":true}'); }, ${tmo});
    try { root.$request(${JSON.stringify(params)}, function(r){ clearTimeout(t); resolve(JSON.stringify({ ok: true, res: r })); }); }
    catch (e) { clearTimeout(t); resolve(JSON.stringify({ __throw: String(e) })); }
  })`;
}
async function callApi(cdp, params, tmo = 20000) {
  const raw = await cdp.evaluate(callExpr(params, tmo), tmo + 15000);
  if (typeof raw !== 'string') throw new Error('页面返回异常');
  const parsed = JSON.parse(raw);
  if (parsed.__timeout) throw new Error('请求超时（可能是网络或登录状态问题）');
  if (parsed.__throw) throw new Error('页面脚本异常: ' + parsed.__throw);
  if (parsed.__err) throw new Error(parsed.__err);
  const r = parsed.res;
  if (!r || r.ret !== 'succ') throw new Error('接口返回异常: ' + JSON.stringify(r).slice(0, 120));
  return r;
}

/* ---------------- 批量模式（抽样/全量） ---------------- */
function loadMembersFromExport() {
  const dir = path.join(ROOT, '导出结果');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('会员导出_') && f.endsWith('.json')).sort();
  if (!files.length) throw new Error('未找到会员导出数据（会员导出_*.json），请先在工具里完成一次导出。');
  const j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const keys = (j.fullHeaders || []).map((h) => { const m = /（([^（）]+)）\s*$/.exec(h); return m ? m[1] : h; });
  const list = [];
  for (const r of (j.fullRows || [])) {
    const o = {}; keys.forEach((k, i) => { o[k] = r[i]; });
    if (o.uid != null) list.push(o);
  }
  return list;
}

/* 分页拉取订单列表（仅基础信息，不拉详情） */
async function fetchOrderList(cdp, m) {
  const uid = Number(m.uid);
  const size = 100;
  let start = 0, orders = [], total = null;
  for (;;) {
    const r = await callApi(cdp, { act: 'searchwashorders', uid, start, size, currentPage: Math.floor(start / size) + 1, currenQuantity: size });
    if (total === null) total = Number(r.total) || 0;
    const rows = r.data || [];
    orders = orders.concat(rows);
    if (orders.length >= total || rows.length < size) break;
    start += size;
    await sleep(350);
  }
  return orders;
}

async function fetchMemberOrders(cdp, m, rackMap) {
  const orders = await fetchOrderList(cdp, m);
  /* 仅保留订单列表基础信息，不再逐单拉取 getorderdetail */
  return { orders, failedOrders: 0, complete: true, listSig: listSig(orders, rackMap) };
}

async function runBatch(cdp, sample) {
  const members = loadMembersFromExport().filter((m) => Number(m.onum) > 0);
  const stride = Math.max(1, Math.floor(members.length / sample));
  const picked = [];
  for (let i = 0; i < members.length && picked.length < sample; i += stride) picked.push(members[i]);

  const jsonlPath = path.join(OUT_DIR, '.orders_results.jsonl');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const doneUids = new Set();
  const sigMap = new Map();
  const lastRowMap = new Map();
  const incompleteUids = new Set();
  if (fs.existsSync(jsonlPath)) {
    const age = Date.now() - fs.statSync(jsonlPath).mtimeMs;
    if (age > 7 * 24 * 3600 * 1000) fs.unlinkSync(jsonlPath);
    else {
      const lastByUid = new Map();
      for (const ln of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
        if (!ln) continue;
        try { const o = JSON.parse(ln); if (o && o.uid != null) lastByUid.set(String(o.uid), o); } catch (e) { /* ignore */ }
      }
      for (const [u, o] of lastByUid) {
        doneUids.add(u);
        lastRowMap.set(u, o);
        if (o.sig) sigMap.set(u, o.sig);
        if (o.complete === false) incompleteUids.add(u);
      }
    }
  }
  /* 架号索引 */
  let rackMap = new Map();
  try {
    const rp = await callApi(cdp, { act: 'getposcodenew' }, 25000);
    for (const row of (rp.data || [])) if (row && row.orderid != null) rackMap.set(String(row.orderid), String(row.poscode));
    console.log(`  架号索引：${rackMap.size} 条（getposcodenew）`);
  } catch (e) { console.log(`      [提示] 架号索引获取失败（${e.message}），本次订单架号将为空`); }

  /* 增量比对 */
  const todo = [];
  let skipN = 0, newN = 0, chgN = 0, redoN = 0;
  for (const m of picked) {
    const u = String(m.uid);
    if (doneUids.has(u) && incompleteUids.has(u)) { redoN++; todo.push(m); continue; }
    if (!doneUids.has(u)) { newN++; todo.push(m); continue; }
    if (sigMap.get(u) !== memberSig(m)) { chgN++; todo.push(m); continue; }
    try {
      const rows = await fetchOrderList(cdp, m);
      const lsig = listSig(rows, rackMap);
      m.__lsig = lsig;
      const last = lastRowMap.get(u);
      if (last && last.listSig === lsig) { skipN++; continue; }
      chgN++; todo.push(m);
    } catch (e) {
      console.log(`      [提示] ${m.name || u} 订单列表取数失败（${e.message}），保守重抓`);
      await sleep(800);
      chgN++; todo.push(m);
    }
  }
  const mode = picked.length >= members.length ? '全量' : '抽样';
  console.log(`  ${mode} ${picked.length} 人（含订单会员共 ${members.length} 人）；数据比对：内容一致跳过 ${skipN} 人，需抓取 ${todo.length} 人（新增 ${newN}、内容有变化 ${chgN}、补抓失败 ${redoN}）`);
  console.log('');  console.log('');

  const t0 = Date.now();
  let okCount = 0, failCount = 0, orderTotal = 0, consecutiveFail = 0, doneSinceRest = 0;
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i];
    const uid = String(m.uid);
    try {
      const ok = await cdp.evaluate('(function(){ try { return !!((localStorage.getItem("code")||"").length); } catch(e){ return true; } })()', 5000);
      if (ok === false) { console.log('  [重要] 登录状态已失效，停止（已抓数据均保留，重新登录后重跑可续传）。'); break; }
    } catch (e) { /* ignore */ }
    const mStart = Date.now();
    let result = null, lastErr = null;
    try { result = await fetchMemberOrders(cdp, m, rackMap); }
    catch (e) {
      lastErr = e;
      await waitLong(60, `${m.name || uid} 抓取失败（${e.message}），按规则暂停 60 秒`);
    }
    if (!result) {
      failCount++; consecutiveFail++;
      console.log(`  [${i + 1}/${todo.length}] ${m.name || uid} 抓取失败：${(lastErr && lastErr.message) || ''}`);
      if (consecutiveFail >= 4) { console.log('  连续失败过多，提前停止（稍后重跑可续传）。'); break; }
      continue;
    }
    consecutiveFail = 0; okCount++; orderTotal += result.orders.length;
    const mSec = Math.round((Date.now() - mStart) / 1000);
    result.orders.forEach((o) => { const pc = rackMap.get(String(o.orderid)) || o.poscode || ''; if (pc) o.poscode = pc; });
    const lsig = (result.listSig != null) ? result.listSig : ((typeof m.__lsig === 'string') ? m.__lsig : '');
    appendJsonlSync(jsonlPath, JSON.stringify({ uid: m.uid, name: m.name || '', phone: m.phone || '', sig: memberSig(m), listSig: lsig, fetchedAt: new Date().toISOString(), orderCount: result.orders.length, failedOrders: result.failedOrders, complete: result.complete, orders: result.orders }) + '\n');
    console.log(`  [${i + 1}/${todo.length}] ${m.name || uid}：${result.orders.length} 单抓取完成（${mSec}s${mSec > 90 ? '，较慢' : ''}）`);
    await sleep(400);
    doneSinceRest++;
    if (doneSinceRest >= 10 && i < todo.length - 1) {
      doneSinceRest = 0;
      await waitLong(60, '已连续抓取 10 人，休息 60 秒后继续');
    }
  }

  const byUid = new Map();
  if (fs.existsSync(jsonlPath)) {
    for (const ln of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
      if (!ln) continue;
      try { const o = JSON.parse(ln); if (o && o.uid != null) byUid.set(String(o.uid), o); } catch (e) { /* ignore */ }
    }
  }
  const all = Array.from(byUid.values());
  const ts = stamp();
  const label = picked.length >= members.length ? '全量' : `抽样${sample}`;
  const outPath = path.join(OUT_DIR, `会员订单_${label}_${ts}.json`);
  const totalOrders = all.reduce((a, x) => a + (x.orders ? x.orders.length : 0), 0);
  fs.writeFileSync(outPath, JSON.stringify({ tool: '洗衣管家订单抓取(批量)', fetchedAt: new Date().toISOString(), memberCount: all.length, orderCount: totalOrders, members: all }), 'utf8');

  const elapsed = (Date.now() - t0) / 1000;
  console.log('');
  console.log(`  本次成功 ${okCount} 人 / 失败 ${failCount} 人；累计已抓 ${all.length} 人、${totalOrders} 单`);
  console.log(`  本次耗时 ${Math.round(elapsed)} 秒；合并文件：${outPath}`);
  const remaining = members.length - all.length;
  if (okCount > 0 && remaining > 0) {
    const per = elapsed / okCount;
    console.log(`  按本次速率估算：剩余 ${remaining} 人约需 ${Math.round(remaining * per / 60)} 分钟`);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  console.log('==================================================');
  console.log('   洗衣管家 · 会员订单数据抓取');
  console.log('==================================================');
  if (!acquireLock()) { setTimeout(() => process.exit(1), 200); return; }
  if (UID) console.log('会员ID:', UID); else console.log(SAMPLE >= 1000000 ? '模式：全量抓取（全部有订单的会员）' : `抽样数量: ${SAMPLE}`);

  const target = await findTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();

  const envRaw = await cdp.evaluate(`(function(){ var u = {}; try { u = JSON.parse(localStorage.getItem('user')||'{}'); } catch(e){} return JSON.stringify({ uid: u.uid||0, href: location.href }); })()`, 10000);
  const env = JSON.parse(envRaw);
  if (!env.uid || /#\/(login|loginucc)/.test(env.href)) { console.error('[错误] 洗衣管家当前未登录，请先登录后再试。'); process.exit(1); }

  if (!UID) {
    await runBatch(cdp, SAMPLE);
    cdp.close();
    setTimeout(() => process.exit(0), 300);
    return;
  }

  /* 单会员模式 */
  const size = 100;
  let start = 0, orders = [], total = null;
  for (;;) {
    const r = await callApi(cdp, { act: 'searchwashorders', uid: Number(UID), start, size, currentPage: Math.floor(start / size) + 1, currenQuantity: size });
    if (total === null) total = Number(r.total) || 0;
    const rows = r.data || [];
    orders = orders.concat(rows);
    console.log(`  订单列表：已获取 ${orders.length} / ${total}`);
    if (orders.length >= total || rows.length < size) break;
    start += size;
    await sleep(400);
  }
  if (!orders.length) { console.log('  该会员没有订单。'); cdp.close(); setTimeout(() => process.exit(0), 200); return; }

  const anyRow = orders[0] || {};
  const member = { uid: Number(UID), name: anyRow.name || '', phone: anyRow.phone || '' };

  /* 仅保留订单列表基础信息 */
  console.log(`  已获取 ${orders.length} 笔订单（基础信息）`);

  const ts = stamp();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    tool: '洗衣管家订单抓取',
    fetchedAt: new Date().toISOString(),
    member,
    orderCount: orders.length,
    orders,
  };
  const jsonPath = path.join(OUT_DIR, `订单_${member.name || member.uid}_${UID}_${ts}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  console.log('');
  console.log('  数据文件：', jsonPath);

  /* HTML 预览 */
  if (MAKE_HTML) {
    const htmlPath = path.join(OUT_DIR, `订单预览_${member.name || member.uid}_${UID}_${ts}.html`);
    fs.writeFileSync(htmlPath, buildHtml(payload, path.basename(jsonPath)), 'utf8');
    console.log('  预览页面：', htmlPath);
  }
  console.log('');
  console.log('完成。');

  cdp.close();
  setTimeout(() => process.exit(0), 300);
}

/* ---------------- HTML 预览页（简化版：仅订单列表表格） ---------------- */
function buildHtml(p, jsonName) {
  const orders = p.orders;
  let totalRmb = 0;
  const rows = orders.map((o) => {
    totalRmb += Number(o.trmb) || 0;
    return `<tr>
      <td>${esc(o.sncode)}</td>
      <td>${esc(o.orderid)}</td>
      <td class="num">¥${fmtYuan(o.trmb)}</td>
      <td>${esc(o.wstatus_name || ('状态码 ' + (o.wstatus != null ? o.wstatus : '—')))}</td>
      <td class="time">${esc(o.ctime || '')}</td>
      <td>${esc(o.poscode || '')}</td>
    </tr>`;
  }).join('');

  const css = `
  :root { --ink:#1c2430; --sub:#5b6675; --line:#e2e6ee; --accent:#2b54a8; }
  * { box-sizing:border-box; }
  body { margin:0; background:#f6f7f9; color:var(--ink); font:14px/1.75 "Microsoft YaHei","微软雅黑",sans-serif; }
  .page { max-width:920px; margin:0 auto; padding:36px 22px 70px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:.4px; }
  .meta { color:var(--sub); font-size:13px; }
  .stats { margin:18px 0 4px; padding:12px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:6px 30px; font-size:13.5px; }
  .stats b { color:var(--accent); font-variant-numeric:tabular-nums; font-weight:700; }
  table { border-collapse:collapse; width:100%; margin:16px 0; font-size:13px; }
  th { text-align:left; color:var(--sub); font-weight:600; border-bottom:2px solid var(--line); padding:6px 8px 6px 0; }
  td { border-bottom:1px solid #eef1f5; padding:6px 8px 6px 0; font-variant-numeric:tabular-nums; }
  th.num, td.num { text-align:right; }
  .time { color:var(--sub); font-size:12.5px; }
  .note { margin-top:26px; font-size:12.5px; color:var(--sub); border-top:1px solid var(--line); padding-top:12px; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>会员订单数据 · 预览</title><style>${css}</style></head>
<body><div class="page">
<header>
  <h1>会员订单数据 · 预览</h1>
  <div class="meta">${esc(p.member.name || '（未登记姓名）')} ｜ ${esc(p.member.phone)} ｜ 会员ID ${esc(p.member.uid)} ｜ 抓取时间 ${esc(new Date(p.fetchedAt).toLocaleString('zh-CN'))}</div>
</header>
<div class="stats">
  <span>订单 <b>${orders.length}</b> 笔</span>
  <span>合计消费 <b>¥${fmtYuan(totalRmb)}</b></span>
</div>
<table><thead><tr>
  <th>业务码</th><th>订单ID</th><th class="num">金额</th><th>状态</th><th>时间</th><th>架号</th>
</tr></thead><tbody>${rows}</tbody></table>
<div class="note">
  数据来自洗衣管家只读抓取，仅含订单基础信息。<br>
  完整原始数据：同目录下的 <a href="./${esc(jsonName)}">${esc(jsonName)}</a>
</div>
</div></body></html>`;
}

main().catch((e) => { console.error('[错误]', (e && e.message) || e); process.exit(1); });