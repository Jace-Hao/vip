#!/usr/bin/env node
/* ============================================================
 * 洗衣管家 · 会员数据导出工具（export.mjs）v1.1
 * ------------------------------------------------------------
 * 功能：
 *   1) 常规导出：联系人/电话/级别/余额等 9 列汇总（csv/json/xlsx）
 *   2) 全量字段：会员列表接口返回的【全部字段】（csv/xlsx，含在 json 里）
 *   3) 深度详情（--deep）：逐会员抓取详情（标签、券、卡、订单、充值等）；
 *      增量比对：仅抓取新增/有变更的会员（--deep-full 可强制全量）；
 *      支持断点续传；统一限速（最小间隔+抖动+小时预算）；失败按指数退避等待重试；
 *
 * 原理：洗衣管家是内嵌浏览器(CefSharp)的桌面程序，运行在 127.0.0.1:9222
 *       调试端口上。本工具在该端口内调用软件自身的接口读取数据。
 * 只读用途：不会修改软件内任何内容。
 * 依赖：Node.js 18+（内置 fetch / WebSocket，无第三方包）
 * 用法：node export.mjs [--deep] [--deep-full] [--deep-limit=N] [--out=目录] [--page-size=200]
 *       [--min-interval=2200] [--jitter=1000]
 *
 * 限速（重要）：
 *   洗衣管家服务端有风控，短时间大量请求会导致接口「冷却」甚至直接踢掉登录账号。
 *   所有接口调用均经 app/rate_limit.mjs 统一限速，参数可用命令行或环境变量覆盖：
 *     --min-interval=<毫秒>   相邻请求最小间隔（默认 2200）
 *     --jitter=<毫秒>         额外随机抖动上限（默认 1000）
 *     LAUNDRY_MIN_INTERVAL_MS / LAUNDRY_JITTER_MS
 *   夜间慢速跑示例：
 *     set LAUNDRY_MIN_INTERVAL_MS=5000 & node export.mjs --deep
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { RateLimiter, pickNum, backoffSeconds } from './rate_limit.mjs';
import { isTargetGroup, TARGET_GROUP } from './group_filter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARGV = process.argv.slice(2);

/* ---------------- 配置 ---------------- */
const CDP_BASE = 'http://127.0.0.1:9222';
const STATUS_MAP = { 0: '正常', 1: '禁用' };

/* ---------------- 限速配置（防止触发服务端风控被踢下线） ---------------- */
/* 默认值按「安全优先」设定：约 1962 个会员的详情阶段约需 5~7 小时，
   配合断点续传可在夜间跑完；如需更快/更慢，用上面的参数覆盖即可。 */
const MIN_INTERVAL_MS = pickNum({ argv: ARGV, arg: 'min-interval', env: 'LAUNDRY_MIN_INTERVAL_MS', def: 2200 });
const JITTER_MS = pickNum({ argv: ARGV, arg: 'jitter', env: 'LAUNDRY_JITTER_MS', def: 1000 });
/* 每实际抓取 REST_EVERY 个会员后长休息，休息时长随连续失败指数退避（REST_BASE_SEC → REST_MAX_SEC） */
const REST_EVERY = pickNum({ argv: ARGV, arg: 'rest-every', env: 'LAUNDRY_REST_EVERY', def: 60 });
const REST_BASE_SEC = pickNum({ argv: ARGV, arg: 'rest-sec', env: 'LAUNDRY_REST_SEC', def: 90 });
const REST_MAX_SEC = pickNum({ argv: ARGV, arg: 'rest-max', env: 'LAUNDRY_REST_MAX', def: 900 });
/* 单批失败后的等待：60 → 120 → 240 … 秒（指数退避，上限 FAIL_MAX_SEC） */
const FAIL_BASE_SEC = pickNum({ argv: ARGV, arg: 'fail-sec', env: 'LAUNDRY_FAIL_SEC', def: 60 });
const FAIL_MAX_SEC = pickNum({ argv: ARGV, arg: 'fail-max', env: 'LAUNDRY_FAIL_MAX', def: 600 });
/* 深度抓取批次大小：固定为 1，使 Node 侧能对每个会员精确限速（页内脚本连发无法限速） */
const DEEP_BATCH = 1;

/* 全量字段的中文名（仅收录有把握的；未收录的字段以原字段名显示） */
const FULL_LABELS = {
  uid: '会员ID', groupid: '集团ID', topid: '商户ID', pshopid: '上级门店ID', shopid: '门店ID',
  corpid: '企业ID', cid: '客户ID', suid: '关联用户ID', score: '积分', vipid: '会员级别ID',
  plusid: 'PLUS会员ID', type: '渠道类型(1店内2公众号)', isbind: '公众号绑定(1已绑0未绑)', status: '状态(0正常1禁用)',
  onum: '累计订单数', ocnum: '累计订单件数', ormb: '累计订单金额·分', crmb: '累计充值·分', zrmb: '累计赠送·分',
  cnum: '卡张数', cardnum: '会员卡号', cardrmb: '会员卡余额·分', balance: '账户余额·分',
  b_crmb: '余额-充值部分·分', b_zrmb: '余额-赠送部分·分', sex: '性别', age: '年龄', birth: '生日',
  nick: '昵称', logo: '头像', name: '姓名', py: '姓名拼音', phone: '手机号', rphone: '手机号-倒序',
  ip: '最后登录IP', tagids: '标签ID', note: '备注', birthday: '生日时间', otime: '最近动态时间',
  mtime: '最后修改时间', ctime: '注册时间', source: '来源', vip_name: '会员级别名称', vipname: '级别名称',
  vip_cut: '折扣值', cut: '折扣值2', sname: '所属门店', oldvipid: '原级别ID',
  address: '地址', province: '省ID', city: '市ID', county: '区县ID',
  province_name: '省', city_name: '市', county_name: '区县',
  zbalance: '赠送余额·分', cbalance: '充值余额·分', corpname: '企业名称', scorermb: '积分金额·分',
  tagname: '标签名称', chargeno: '最近充值单号', chargeshop: '最近充值门店',
  chargetime: '最近充值时间', chargermb: '最近充值金额·分', edate: '到期日期',
};

let OUT_DIR = path.join(ROOT, '导出结果');
let PAGE_SIZE = 200;
let DEEP = false;
let DEEP_FULL = false; // --deep-full：跳过比对，强制全量重抓
let DEEP_LIMIT = 0; // >0 时仅取前 N 个会员（测试用）
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--out=')) OUT_DIR = path.resolve(a.slice(6));
  else if (a.startsWith('--page-size=')) {
    const n = parseInt(a.slice(12), 10);
    if (n) PAGE_SIZE = Math.min(200, Math.max(10, n));
  } else if (a === '--deep') DEEP = true;
  else if (a === '--deep-full') { DEEP = true; DEEP_FULL = true; }
  else if (a.startsWith('--deep-limit=')) DEEP_LIMIT = Math.max(1, parseInt(a.slice(13), 10) || 0);
}
if (!DEEP_LIMIT && process.env.LAUNDRY_DEEP_LIMIT) {
  const n = parseInt(process.env.LAUNDRY_DEEP_LIMIT, 10);
  if (n > 0) DEEP_LIMIT = n;
}

/* ---------------- 小工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 追加写入 jsonl 并强制刷盘，确保 kill/断电等异常退出不丢已抓数据 */
function appendJsonlSync(filePath, content) {
  fs.appendFileSync(filePath, content, 'utf8');
  try { const fd = fs.openSync(filePath, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); } catch (e) { /* fsync 失败不阻塞，仅影响极端场景下的断点续传 */ }
}

/* 失败时的长等待：等待指定秒数后再继续（等待期间每 60 秒提示一次，便于确认程序在运行） */
async function waitLong(seconds, reason) {
  log(`      [提示] ${reason}；等待 ${seconds} 秒后自动继续...`);
  const step = 10;
  for (let waited = 0; waited < seconds; waited += step) {
    await sleep(Math.min(step, seconds - waited) * 1000);
    const elapsed = waited + step;
    const remain = seconds - elapsed;
    if (remain > 0) log(`        ⏳ 剩余约 ${remain} 秒 ...`);
  }
  log(`        ✅ 等待结束，继续执行`);
}
let cdp = null;

function log(...args) { console.log(...args); }

/* 全局限速器：所有对洗衣管家的接口调用都必须先 acquire() */
const limiter = new RateLimiter({
  name: '会员导出',
  minIntervalMs: MIN_INTERVAL_MS,
  jitterMs: JITTER_MS,
  log,
});

function die(msg, code = 1) {
  console.error('\n[错误] ' + msg);
  try { if (cdp) cdp.close(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(code), 250);
  throw new Error('__EXIT__');
}

function statusText(s) {
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, s) ? STATUS_MAP[s] : ('状态' + s);
}

/* 会员“指纹”：用于增量比对判断数据是否变更（排除易变的登录IP字段） */
function memberSig(m) {
  const o = {};
  for (const k of Object.keys(m).sort()) {
    if (k === 'ip') continue;
    o[k] = m[k];
  }
  return createHash('md5').update(JSON.stringify(o)).digest('hex');
}

/* 订单列表签名：getuinfo 订单行（状态/金额/时间）任一变化都会改变签名 */
function orderListSig(detail) {
  try {
    const rows = (detail && detail.order && detail.order.list) || [];
    const mini = rows.map((r) => [r.orderid, r.wstatus, r.trmb, r.ctime, r.cnum]);
    return createHash('md5').update(JSON.stringify(mini)).digest('hex');
  } catch (e) { return ''; }
}
/* 详情双签名：会员字段 + 订单列表内容 */
function detailSig(m, detail) {
  return createHash('md5').update(memberSig(m) + '|' + orderListSig(detail)).digest('hex');
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvEsc(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- CDP 连接 ---------------- */
async function findTarget() {
  let list;
  try {
    const r = await fetch(CDP_BASE + '/json/list', { signal: AbortSignal.timeout(6000) });
    list = await r.json();
  } catch (e) {
    die('无法连接洗衣管家调试端口(127.0.0.1:9222)。\n' +
        '  请确认：1) 洗衣管家正在运行；2) 已登录门店账号。\n' +
        '  如多次提示此错误，请完全退出洗衣管家后，运行工具目录下的\n  「以调试模式启动洗衣管家.cmd」重新打开软件。');
  }
  const pages = (list || []).filter((t) => t.type === 'page' && typeof t.url === 'string');
  const app = pages.find((t) => t.url.startsWith('xy://') && t.url.includes('/main/')) ||
              pages.find((t) => t.url.startsWith('xy://')) ||
              pages.find((t) => t.title === '洗衣管家');
  if (!app) die('未找到洗衣管家页面，请确认软件已打开。');
  return app;
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onErr = (e) => reject(new Error('调试端口连接失败: ' + ((e && e.message) || e)));
      ws.addEventListener('open', () => { ws.removeEventListener('error', onErr); resolve(); });
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('message', (ev) => {
        let obj;
        try { obj = JSON.parse(ev.data); } catch (e) { return; }
        if (obj.id && this.pending.has(obj.id)) {
          const p = this.pending.get(obj.id);
          this.pending.delete(obj.id);
          p.resolve(obj);
        }
      });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.id;
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, timeoutMs = 30000) {
    let timer = null;
    try {
      const res = await Promise.race([
        this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('页面执行超时(' + timeoutMs + 'ms)')), timeoutMs); }),
      ]);
      const r = res.result || {};
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('页面脚本异常: ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 220));
      }
      const payload = r.result || {};
      if (payload.subtype === 'error' || payload.type === 'undefined') return undefined;
      return payload.value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  close() { try { this.ws && this.ws.close(); } catch (e) { /* ignore */ } }
}

/* ---------------- 页面内脚本 ---------------- */
const ROOT_FINDER = `
  const __findRoot = () => {
    const cands = [document.querySelector('.app'), document.querySelector('#app')];
    for (const c of cands) { if (c && c.__vue__) return c.__vue__; }
    const w = (el) => { if (el && el.__vue__) return el.__vue__; for (const ch of ((el && el.children) || [])) { const r = w(ch); if (r) return r; } return null; };
    return w(document.body);
  };
`;

const ENV_EXPR = `(() => {
  ${ROOT_FINDER}
  const out = { href: location.href, ready: document.readyState, version: localStorage.getItem('version') || '' };
  let user = {}, shop = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) {}
  try { shop = JSON.parse(localStorage.getItem('curshop') || '{}'); } catch (e) {}
  out.uid = user.uid || 0;
  out.shopName = shop.name || '';
  const root = __findRoot();
  out.hasApi = !!(root && root.$request);
  return JSON.stringify(out);
})()`;

function pageExpr(start, size) {
  return `new Promise((resolve) => {
    ${ROOT_FINDER}
    const root = __findRoot();
    if (!root || !root.$request) { resolve(JSON.stringify({ err: '页面数据接口未就绪' })); return; }
    const timer = setTimeout(() => resolve(JSON.stringify({ err: '页面请求超时' })), 25000);
    root.$request({
      act: 'gettopuserlist', callType: false,
      start: ${start}, size: ${size}, currentPage: ${Math.floor(start / size) + 1}, currenQuantity: ${size},
      orderby: 0, selected: '0', range: '', vipid: '', shopid: '', corpid: '', tagid: '', using: '',
      kword: '', sdate: '', edate: '', days: null
    }, (r) => {
      clearTimeout(timer);
      try {
        const list = (r && (r.data || r.list)) || [];
        resolve(JSON.stringify({ ret: r.ret, total: r.total, len: list.length, list: list }));
      } catch (e) { resolve(JSON.stringify({ err: '数据解析失败: ' + e })); }
    });
  })`;
}

function deepExpr(uids) {
  return `new Promise(async (resolve) => {
    ${ROOT_FINDER}
    const root = __findRoot();
    if (!root || !root.$request) { resolve(JSON.stringify({ err: '页面数据接口未就绪' })); return; }
    const uids = ${JSON.stringify(uids)};
    const out = new Array(uids.length);
    let idx = 0;
    const worker = async () => {
      while (idx < uids.length) {
        const k = idx++;
        const uid = uids[k];
        out[k] = await new Promise((res) => {
          /* 注意：页面隐藏时 Chromium 会节流 setTimeout，因此这里不使用循环内定时器；
             连发请求由网络回调驱动，不受节流影响。失败兜底超时仅在异常时生效。 */
          const to = setTimeout(() => res({ uid: uid, error: 'timeout' }), 10000);
          try {
            root.$request({ uid: uid, hcard: 1, vipcard: 1, ticket: 1, order: 1, act: 'getuinfo' }, (r) => {
              clearTimeout(to);
              if (r && r.ret === 'succ' && r.data) res({ uid: uid, detail: r.data });
              else res({ uid: uid, error: (r && (r.tip || r.ret)) || 'fail' });
            });
          } catch (e) { clearTimeout(to); res({ uid: uid, error: String(e) }); }
        });
      }
    };
    await worker();
    resolve(JSON.stringify({ results: out }));
  })`;
}

async function fetchPageWithRetry(start, size) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await limiter.acquire();
      const raw = await cdp.evaluate(pageExpr(start, size), 40000);
      if (typeof raw !== 'string') throw new Error('页面返回内容异常');
      const res = JSON.parse(raw);
      if (res.err) throw new Error(res.err);
      if (res.ret !== 'succ') throw new Error('接口返回: ' + JSON.stringify(res).slice(0, 160));
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt >= 5) break;
      if (attempt <= 2) {
        log(`    取数失败（${e.message}），${attempt}/5，快速重试中...`);
        await sleep(1500 * attempt);
      } else {
        /* 指数退避（与其它失败分支完全同口径）：60 → 120 → 240 秒，上限 FAIL_MAX_SEC */
        const waitSec = backoffSeconds(attempt, FAIL_BASE_SEC, FAIL_MAX_SEC);
        await waitLong(waitSec, `第 ${attempt} 次取数失败（${e.message}），退避 ${waitSec} 秒`);
      }
    }
  }
  die('连续多次获取数据失败：' + (lastErr && lastErr.message));
}

/* 深度详情批次：整批失败时二分拆小重试一次，尽量隔离个别卡住的会员 */
async function fetchDetailBatch(uids, isSplit = false) {
  if (!uids.length) return [];
  try {
    await limiter.acquire();
    const raw = await cdp.evaluate(deepExpr(uids), isSplit ? 45000 : 60000);
    if (typeof raw !== 'string') throw new Error('页面返回异常');
    const res = JSON.parse(raw);
    if (res.err) throw new Error(res.err);
    return res.results || [];
  } catch (e) {
    if (uids.length === 1 || isSplit) {
      return uids.map((u) => ({ uid: u, error: '失败: ' + e.message }));
    }
    /* 说明：当前 DEEP_BATCH = 1（见文件顶部限速配置），uids.length 恒为 1，
       上面的 `uids.length === 1` 分支必然命中，因此本段二分拆分【不会被执行】。
       保留它是因为一旦将来把 DEEP_BATCH 调大，拆批隔离逻辑立刻重新生效，
       请勿误判为不可达代码而删除。 */
    await sleep(2500);
    const half = Math.ceil(uids.length / 2);
    const a = await fetchDetailBatch(uids.slice(0, half), true);
    const b = await fetchDetailBatch(uids.slice(half), true);
    return a.concat(b);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  log('==================================================');
  log('        洗衣管家 · 会员数据导出工具');
  log('==================================================');
  if (typeof fetch !== 'function' || typeof WebSocket !== 'function') {
    die('Node.js 版本过低（需要 18 或更高版本）。');
  }

  log('');
  log('[1/5] 正在连接洗衣管家 ...');
  const target = await findTarget();
  log('      已找到页面：' + target.url.split('#')[0]);

  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();

  log('');
  log('[2/5] 正在检查登录状态 ...');
  let envInfo;
  try {
    const raw = await cdp.evaluate(ENV_EXPR, 15000);
    envInfo = JSON.parse(raw);
  } catch (e) {
    die('读取页面信息失败：' + e.message);
  }
  if (!envInfo.uid || /#\/(login|loginucc)/.test(envInfo.href)) {
    die('洗衣管家当前未登录。请先在软件中登录门店账号，然后再运行本工具。');
  }
  if (!envInfo.hasApi) {
    die('未找到数据接口（软件版本可能已变化）。请联系工具维护者更新。');
  }
  log(`      门店：${envInfo.shopName || '(未知)'} | 软件版本：${envInfo.version || '(未知)'}`);

  log('');
  log('[3/5] 正在读取会员数据（只读操作，不影响软件正常使用）...');
  const members = [];
  const seen = new Set();
  let dupCount = 0;
  let excludedCount = 0; /* 非目标组别（非「${TARGET_GROUP}」）被采集层排除的数量 */
  let total = null;
  let start = 0;
  let pageNo = 0;

  for (;;) {
    if (total !== null && start >= total) break;
    if (pageNo >= 80) { log('      [提示] 达到安全页数上限，提前结束。'); break; }
    log(`      正在获取第 ${pageNo + 1} 页 ...`);
    const res = await fetchPageWithRetry(start, PAGE_SIZE);
    if (total === null) total = Number(res.total) || null;
    const list = res.list || [];
    if (list.length === 0) break;
    for (const it of list) {
      const key = it.uid != null ? String(it.uid) : JSON.stringify(it);
      if (seen.has(key)) { dupCount++; continue; }
      seen.add(key);
      /* 采集层组别过滤：非目标组别在采集阶段即排除，不进入后续导出/同步 */
      if (!isTargetGroup(it)) { excludedCount++; continue; }
      members.push(it);
    }
    log(`        已筛入「${TARGET_GROUP}」${members.length}${total ? ' 条（接口返回共 ' + total + ' 条' : ''}，本页起累计排除非目标组别 ${excludedCount} 条）`);
    if (list.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    pageNo++;
    await sleep(220);
  }
  if (!members.length) die('未获取到任何会员数据。');

  const ts = stamp();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* ---- 组装输出数据 ---- */
  const sumHeaders = ['联系人', '电话', '会员级别', '账户余额(元)', '会员卡号', '订单数', '注册时间', '来源', '状态'];
  const sumRows = members.map((m) => {
    const card = (m.cardnum && String(m.cardnum) !== '0') ? String(m.cardnum) : '';
    const balNum = Number(m.balance);
    return [
      m.name == null ? '' : String(m.name),
      m.phone == null ? '' : String(m.phone),
      m.vip_name || m.vipname || '',
      Number.isFinite(balNum) ? Number((balNum / 100).toFixed(2)) : 0,
      card,
      Number(m.onum) || 0,
      m.ctime || '',
      m.source || '',
      statusText(m.status),
    ];
  });

  // 全量字段：按首条记录的键序为基准，动态并集
  const fullKeys = [];
  const keySeen = new Set();
  for (const m of members) {
    for (const k of Object.keys(m)) {
      if (!keySeen.has(k)) { keySeen.add(k); fullKeys.push(k); }
    }
  }
  const fullHeaders = fullKeys.map((k) => (FULL_LABELS[k] ? `${FULL_LABELS[k]}（${k}）` : k));
  const fullRows = members.map((m) => fullKeys.map((k) => {
    const v = m[k];
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  }));

  const sumCents = members.reduce((s, m) => s + (Number(m.balance) || 0), 0);
  const sumYuan = (sumCents / 100).toFixed(2);

  const baseName = `会员导出_${ts}`;
  const fullBase = `会员全量数据_${ts}`;
  const csvPath = path.join(OUT_DIR, baseName + '.csv');
  const jsonPath = path.join(OUT_DIR, baseName + '.json');
  const fullCsvPath = path.join(OUT_DIR, fullBase + '.csv');
  const fullXlsxPath = path.join(OUT_DIR, fullBase + '.xlsx');

  log('');
  log('[4/5] 正在保存文件 ...');

  // 汇总 CSV
  const csvLines = [sumHeaders.join(',')];
  for (const r of sumRows) {
    const cells = r.map((v, i) => (i === 3 ? Number(v).toFixed(2) : csvEsc(v)));
    csvLines.push(cells.join(','));
  }
  fs.writeFileSync(csvPath, '\uFEFF' + csvLines.join('\r\n') + '\r\n', 'utf8');

  // 全量字段 CSV
  const fcsvLines = [fullHeaders.map(csvEsc).join(',')];
  for (const r of fullRows) {
    fcsvLines.push(r.map(csvEsc).join(','));
  }
  fs.writeFileSync(fullCsvPath, '\uFEFF' + fcsvLines.join('\r\n') + '\r\n', 'utf8');

  // 主 JSON（含汇总与全量字段，供生成 Excel）
  const payload = {
    tool: '洗衣管家会员导出',
    exportedAt: new Date().toISOString(),
    shop: envInfo.shopName || '',
    softwareVersion: envInfo.version || '',
    total: sumRows.length,
    sumBalanceYuan: Number(sumYuan),
    headers: sumHeaders,
    rows: sumRows,
    fullHeaders,
    fullRows,
    fullLabels: FULL_LABELS,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');

  const ptr = {
    json: jsonPath,
    xlsx: jsonPath.replace(/\.json$/, '.xlsx'),
    fullCsv: fullCsvPath,
    fullXlsx: fullXlsxPath,
    stamp: ts,
  };

  log(`      会员总数（目标组别「${TARGET_GROUP}」）：${members.length} 条${dupCount ? `（已去重 ${dupCount} 条）` : ''}${excludedCount ? `；本次共排除非目标组别 ${excludedCount} 条` : ''}`);
  log(`      账户余额合计：¥${sumYuan}`);

  /* ---- 深度详情（可选） ---- */
  if (DEEP) {
    let deepTargets = members;
    if (DEEP_LIMIT > 0) deepTargets = members.slice(0, DEEP_LIMIT);
    const jsonlPath = path.join(OUT_DIR, '.deep_results.jsonl');
    const deepJsonPath = path.join(OUT_DIR, `会员详情_${ts}.json`);
    const deepXlsxPath = path.join(OUT_DIR, `会员详情_${ts}.xlsx`);

    // ===== 增量比对：加载/建立缓存，只抓取新增或有变更的会员 =====
    const cachePath = path.join(OUT_DIR, '.detail_cache.json');
    let cache = null;
    try { if (fs.existsSync(cachePath)) cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (e) { cache = null; }
    if (!cache || !cache.entries) {
      cache = { savedAt: '', entries: {} };
      if (!DEEP_FULL) {
        let seeded = 0, baseline = 0;
        try {
          const detFiles = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('会员详情_') && f.endsWith('.json')).sort();
          const detMap = new Map();
          if (detFiles.length) {
            const dj = JSON.parse(fs.readFileSync(path.join(OUT_DIR, detFiles[detFiles.length - 1]), 'utf8'));
            for (const d of (dj.details || [])) { if (d && d.uid != null) detMap.set(String(d.uid), d); }
          }
          const curSnap = `会员导出_${ts}.json`; // 排除本次自己的快照，取上一次的列表作为比对基准
          const listFiles = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('会员导出_') && f.endsWith('.json') && f !== curSnap).sort();
          const oldSigs = new Map();
          if (listFiles.length) {
            const oj = JSON.parse(fs.readFileSync(path.join(OUT_DIR, listFiles[listFiles.length - 1]), 'utf8'));
            if (oj.fullHeaders && oj.fullRows) {
              const keys = oj.fullHeaders.map((h) => { const mm = /（([^（）]+)）\s*$/.exec(h); return mm ? mm[1] : h; });
              for (const r of oj.fullRows) {
                const mo = {}; keys.forEach((kk, ii) => { mo[kk] = r[ii]; });
                if (mo.uid != null) oldSigs.set(String(mo.uid), memberSig(mo));
              }
            }
          }
          for (const [uid, det] of detMap) {
            cache.entries[uid] = { memberSig: oldSigs.get(uid) || null, detailSig: null, detail: det };
            seeded++;
          }
          baseline = oldSigs.size;
        } catch (e) { log('      [提示] 建立比对缓存时出现问题（将按需重抓）：' + (e && e.message)); }
        if (seeded) log(`      首次启用增量比对：已从既有数据建立缓存（${seeded} 人；其中 ${baseline} 人有比对基准）`);
      }
    }

    // 断点续传：读取本次已完成的 uid（超过 20 小时视为过期，重新开始）
    const doneUids = new Set();
    if (fs.existsSync(jsonlPath)) {
      const ageMs = Date.now() - fs.statSync(jsonlPath).mtimeMs;
      if (ageMs > 20 * 3600 * 1000) {
        fs.unlinkSync(jsonlPath);
      } else {
        for (const ln of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
          if (!ln) continue;
          try { const o = JSON.parse(ln); if (o && o.uid != null) doneUids.add(String(o.uid)); } catch (e) { /* 忽略半行 */ }
        }
        if (doneUids.size) log(`      检测到中断记录：本次已完成 ${doneUids.size} 个，跳过（断点续传）`);
      }
    }

    // 变更比对 v3：先比对 memberSig（会员列表字段），仅字段有变化的才调用 getuinfo
    let needFetch = [];
    if (DEEP_FULL) {
      const fullN = deepTargets.filter((m) => !doneUids.has(String(m.uid))).length;
      log(`      已指定全量刷新模式（--deep-full）：将重新获取全部会员详情（本次 ${fullN} 个）`);
      log('      [提醒] 全量刷新会跳过增量比对，请求数直接等于会员数，最容易触发服务端风控；');
      log('             日常同步请勿加 --deep-full，让工具按 memberSig 只抓新增/有变更的会员。');
      needFetch = deepTargets.filter((m) => !doneUids.has(String(m.uid)));
    } else {
      let sigSkip = 0, sigChg = 0, noCache = 0;
      for (const m of deepTargets) {
        const uid = String(m.uid);
        if (doneUids.has(uid)) continue; // 断点续传已完成的跳过
        const e = cache.entries[uid];
        if (!e || !e.memberSig) { noCache++; needFetch.push(m); continue; }
        if (e.memberSig !== memberSig(m)) { sigChg++; needFetch.push(m); continue; }
        // memberSig 一致：会员字段无变化，使用缓存中的旧详情（不调用 getuinfo）
        sigSkip++;
      }
      log(`      增量比对 v3：${deepTargets.length} 人中已完成 ${doneUids.size} 人，memberSig 一致跳过 ${sigSkip} 人，需抓取 ${needFetch.length} 人（新增/无缓存 ${noCache}、字段变化 ${sigChg}）`);
    }

    const remaining = needFetch;
    const mByUid = new Map(deepTargets.map((m) => [String(m.uid), m]));
    let batchSkippedSame = 0;
    let appended = 0; /* 本轮实际更新人数（跨批次累计） */
    let fetchedSinceRest = 0;
    log('');
    log(`[5/5] 正在抓取会员详情（本次需获取 ${remaining.length} 个 / 共 ${deepTargets.length} 个）...`);

    const BATCH = DEEP_BATCH; /* 固定 1：逐会员限速，避免页内连发造成瞬时突发 */
    const errors = [];
    let done = 0;
    let lastOkAt = Date.now();
    let stopAll = false;
    let restSec = REST_BASE_SEC;   /* 长休息时长，连续失败时指数退避，成功后回落 */
    let consecFail = 0;
    log(`      限速设置：最小间隔 ${MIN_INTERVAL_MS}ms + 抖动 0~${JITTER_MS}ms`);
    log(`      初始状态：${limiter.usage()}`);
    for (let i = 0; i < remaining.length; i += BATCH) {
      /* 登录状态自检：若被软件登出立即停止（避免无效重试） */
      try {
        const authOk = await cdp.evaluate('(function(){ try { return !!((localStorage.getItem("code")||"").length); } catch(e){ return true; } })()', 5000);
        if (authOk === false) {
          log('');
          log('      [重要] 检测到洗衣管家登录状态已失效（可能被软件自动登出）。');
          log('      请在该软件中重新登录后，再次运行本命令：已抓取的数据会自动续传，不会重复。');
          break;
        }
      } catch (e) { /* 自检失败不阻断，继续 */ }

      let batch = remaining.slice(i, i + BATCH);
      let attempt = 0;
      for (;;) {
        attempt++;
        const results = await fetchDetailBatch(batch.map((m) => m.uid));
        const appends = [];
        const failed = [];
        let skippedSame = 0;
        for (const item of results) {
          if (item && item.detail) {
            const mObj = mByUid.get(String(item.uid));
            const newSig = mObj ? detailSig(mObj, item.detail) : null;
            const e = cache.entries[String(item.uid)];
            const unchanged = !DEEP_FULL && newSig && e && e.detail && e.detailSig === newSig;
            if (unchanged) {
              skippedSame++;
              done++; /* 比对一致也计入进度（否则全员无变化时进度恒 0，看起来像卡死） */
            } else {
              appends.push(JSON.stringify({ uid: item.uid, detail: item.detail }));
              done++;
              appended++;
              /* 抓取间歇：每实际抓取 REST_EVERY 个会员长休息一次，降低被限速风险 */
              fetchedSinceRest++;
              if (fetchedSinceRest >= REST_EVERY) {
                fetchedSinceRest = 0;
                await waitLong(restSec, `已连续抓取 ${REST_EVERY} 个会员，休息 ${restSec} 秒（${limiter.usage()}）`);
              }
            }
          } else {
            failed.push(item && item.uid != null ? item.uid : null);
          }
        }
        if (appends.length || skippedSame) lastOkAt = Date.now();
        if (appends.length) {
          appendJsonlSync(jsonlPath, appends.join('\n') + '\n');
        }
        if (failed.length === 0) {
          /* 成功：休息时长回落到基础值 */
          consecFail = 0;
          restSec = REST_BASE_SEC;
          break;
        }
        if (attempt >= 4) {
          for (const u of failed) errors.push({ uid: u, error: '多次重试失败' });
          log(`      （${failed.length} 个会员多次重试仍失败，已跳过；稍后可整体重跑补抓）`);
          break;
        }
        /* 整批全失败通常是服务端风控/登录失效的信号：先立刻自检登录态，避免在已触发风控时继续加压 */
        if (failed.length === batch.length) {
          consecFail++;
          restSec = Math.min(REST_MAX_SEC, backoffSeconds(consecFail, REST_BASE_SEC, REST_MAX_SEC));
          log(`      [重要] 整批 ${failed.length} 个会员全部失败，疑似触发服务端风控（${limiter.usage()}）`);
          try {
            const okEarly = await cdp.evaluate('(function(){ try { return !!((localStorage.getItem("code")||"").length); } catch(e){ return true; } })()', 5000);
            if (okEarly === false) {
              log('      登录状态已失效，立即停止（已抓取的数据均已保存，重新登录后重跑会自动续传）。');
              stopAll = true;
              break;
            }
          } catch (e) { /* 自检失败不阻断，继续退避重试 */ }
        }
        const waitSec = backoffSeconds(attempt, FAIL_BASE_SEC, FAIL_MAX_SEC);
        await waitLong(waitSec, `本批有 ${failed.length} 个会员取数失败（第 ${attempt} 次，退避 ${waitSec} 秒）`);
        batch = batch.filter((m) => failed.indexOf(m.uid) >= 0);
        if (!batch.length) break;
        /* 长等待后再自检一次登录状态 */
        try {
          const ok2 = await cdp.evaluate('(function(){ try { return !!((localStorage.getItem("code")||"").length); } catch(e){ return true; } })()', 5000);
          if (ok2 === false) {
            log('      [重要] 等待期间检测到登录状态已失效，请重新登录后重跑（已抓取的数据均已保存）。');
            stopAll = true;
            break;
          }
        } catch (e) { /* ignore */ }
      }
      if (stopAll) break;
      log(`      详情进度 ${done} / ${remaining.length}${batchSkippedSame ? `（内容一致跳过 ${batchSkippedSame}）` : ''}${errors.length ? `（失败 ${errors.length}）` : ''}`);
      batchSkippedSame = 0;
      if (Date.now() - lastOkAt > 30 * 60 * 1000) {
        log('');
        log('      [提示] 已连续 30 分钟没有成功取回数据，自动停止（数据已保存，稍后可重跑续传）。');
        break;
      }
      /* 相邻批次节奏由统一限速器（limiter）控制，此处不再额外 sleep */
    }

    // 汇总详情：本次抓取结果（jsonl） + 未变更会员的既有缓存
    const fetchedMap = new Map();
    if (fs.existsSync(jsonlPath)) {
      for (const ln of fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/)) {
        if (!ln) continue;
        try { const o = JSON.parse(ln); if (o && o.detail && o.uid != null) fetchedMap.set(String(o.uid), o.detail); } catch (e) { /* ignore */ }
      }
    }
    const details = [];
    for (const m of deepTargets) {
      const uid = String(m.uid);
      const det = fetchedMap.get(uid) || (cache.entries[uid] ? cache.entries[uid].detail : null);
      if (det) details.push(det);
    }
    const orderIndex = new Map(members.map((m, idx) => [String(m.uid), idx]));
    details.sort((a, b) => (orderIndex.get(String(a.uid)) ?? 1e9) - (orderIndex.get(String(b.uid)) ?? 1e9));

    // 更新比对缓存：本次抓到的新数据写入；未变更的保留原缓存
    for (const m of deepTargets) {
      const uid = String(m.uid);
      const det = fetchedMap.get(uid);
      if (det) cache.entries[uid] = { memberSig: memberSig(m), detailSig: detailSig(m, det), detail: det };
    }
    cache.savedAt = new Date().toISOString();
    try { fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8'); } catch (e) { log('      [提示] 比对缓存写入失败：' + (e && e.message)); }

    const deepPayload = {
      tool: '洗衣管家会员导出·会员详情',
      exportedAt: new Date().toISOString(),
      shop: envInfo.shopName || '',
      total: deepTargets.length,
      ok: details.length,
      errorCount: errors.length,
      errors: errors.slice(0, 200),
      details: details,
    };
    fs.writeFileSync(deepJsonPath, JSON.stringify(deepPayload), 'utf8');
    ptr.deepJson = deepJsonPath;
    ptr.deepXlsx = deepXlsxPath;

    if (details.length && errors.length === 0) {
      try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch (e) { /* ignore */ }
      log(remaining.length
        ? (appended > 0 ? '      详情抓取完成：更新 ' + appended + ' 人（临时文件已清理）' : '      比对完成：全部会员数据无变化，无需更新')
        : '      没有需要更新的会员（增量比对完成）');
    } else if (errors.length) {
      log(`      详情抓取结束：成功 ${details.length}，失败 ${errors.length}（失败项可整体重跑本命令补抓）`);
    }
  } else {
    log('[5/5] 完成（未启用详情模式）');
  }

  fs.writeFileSync(path.join(OUT_DIR, '.last_export.json'), JSON.stringify(ptr), 'utf8');

  log('');
  log('==================== 导出完成 ====================');
  log(`  输出目录：${OUT_DIR}`);
  log(`  - ${baseName}.csv / .json （常规表 9 列）`);
  log(`  - ${fullBase}.csv （全量字段 ${fullKeys.length} 列）`);
  if (DEEP) log(`  - 会员详情_${ts}.json （含订单/卡券/标签等完整详情）`);

  cdp.close();
}

main()
  .then(() => {
    /* 正常完成：留出 0.7 秒输出缓冲后强制退出，防止残留句柄拖住进程 */
    setTimeout(() => process.exit(process.exitCode || 0), 700);
  })
  .catch((e) => {
    if (String((e && e.message) || e) !== '__EXIT__') {
      console.error('\n[错误] ' + ((e && e.message) || e));
      process.exitCode = 1;
    }
    setTimeout(() => process.exit(process.exitCode || 1), 700);
  });
