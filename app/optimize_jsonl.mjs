#!/usr/bin/env node
/**
 * .orders_results.jsonl 优化器（低风险、可回滚）
 *
 * 背景：该文件 175MB，其中 97.5% 是 order.detail / order.summary。
 * 实测项目内消费方（app/build_viewer.py、查询页面/index.html、orders_server.mjs）后：
 *   - summary  ：全项目零消费方（grep 无任何 .summary 读取），纯冗余 → 剥离
 *   - detail   ：查询页只用 4 个子字段 data/detail/imgarr/plist → 其余裁剪
 *   - 重复 uid ：24 个 uid 重复写入（续传机制导致），build_viewer 用 order_map[uid]
 *                覆盖式赋值（后写胜），而 readJsonlStats 按行累加 → 两处口径不一致
 *
 * 优化 = 剥离 summary + 裁 detail + 按 uid 去重(保留 fetchedAt 最新)。
 * 严格保持：会员数、订单数、uid 集合、查询页所需 4 个字段全部不变。
 *
 * 用法：
 *   node app/optimize_jsonl.mjs --dry          仅分析，不写文件
 *   node app/optimize_jsonl.mjs --apply        生成优化后文件（保留 .bak 备份）
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSONL = path.join(ROOT, '导出结果', '订单数据', '.orders_results.jsonl');
const OUT = JSONL + '.optimized';
const BAK = JSONL + '.bak';

/* 查询页面 index.html 实际读取的 detail 子字段（orderCardHtml / 订单对比等） */
const KEEP_DETAIL = new Set(['data', 'detail', 'imgarr', 'plist']);

/* 必须保留的订单平级字段：orderid/sncode 供列表与分片反查；detail/summary 另行处理。
   注意：无 detail 的降级订单（2113 笔）本身就是「平铺 84 字段」结构，
   那里没有 detail/summary 可剥离，原样保留即可。 */
const KEEP_ORDER_MIN = new Set(['orderid', 'sncode']);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY = !APPLY;

function fmt(n) { return (n / 1048576).toFixed(1) + 'MB'; }

async function main() {
  if (!fs.existsSync(JSONL)) { console.error('未找到 ' + JSONL); process.exit(1); }
  const sizeBefore = fs.statSync(JSONL).size;

  /* ── 第一遍：流式分析 + 收集每 uid 最新一行 ───────────────────── */
  const latest = new Map();      // uid -> { line, fetchedAt, idx }
  const idsAll = new Set();      // 全部唯一 orderid（用于去重后的完整性校验）
  let lines = 0, bad = 0, orders = 0;
  let sumBytes = 0, droppedDetailBytes = 0, keptDetailBytes = 0;
  let withDetail = 0, withSummary = 0, dupLines = 0, dupBytes = 0;
  const keysSeen = new Set();

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    let o;
    try { o = JSON.parse(line); } catch (e) { bad++; continue; }
    Object.keys(o).forEach(k => keysSeen.add(k));

    const arr = Array.isArray(o.orders) ? o.orders : [];
    orders += arr.length;
    for (const ord of arr) {
      if (ord && ord.orderid != null) idsAll.add(String(ord.orderid));
      if (ord.summary) {
        withSummary++;
        sumBytes += Buffer.byteLength(JSON.stringify(ord.summary));
      }
      if (ord.detail) {
        withDetail++;
        for (const [dk, dv] of Object.entries(ord.detail)) {
          const b = Buffer.byteLength(JSON.stringify(dv) || 'null');
          if (KEEP_DETAIL.has(dk)) keptDetailBytes += b;
          else droppedDetailBytes += b;
        }
      }
    }

    /* 续传机制会重写同一 uid：后写的 fetchedAt 更新，取最新 */
    const uid = String(o.uid);
    const fa = o.fetchedAt || '';
    const prev = latest.get(uid);
    if (prev) {
      dupLines++;
      dupBytes += Buffer.byteLength(raw) + 1;
      if (fa < prev.fetchedAt) continue;   /* 更旧，丢弃 */
    }
    latest.set(uid, { line, fetchedAt: fa, idx: lines });
  }

  const uniqMembers = latest.size;
  const outSizeEst = sizeBefore - sumBytes - droppedDetailBytes - dupBytes;

  console.log('════════ 优化前分析 ════════');
  console.log('  文件大小      : ' + fmt(sizeBefore));
  console.log('  有效行 / 解析失败 : ' + lines + ' / ' + bad);
  console.log('  唯一 uid      : ' + uniqMembers + (dupLines ? '   ← 重复 ' + dupLines + ' 行（' + fmt(dupBytes) + '）' : ''));
  console.log('  订单对象总数  : ' + orders);
  console.log('');
  console.log('  含 summary 订单 : ' + withSummary + '  占 ' + fmt(sumBytes) + '  ← 全项目零消费方，可剥离');
  console.log('  含 detail  订单 : ' + withDetail + '  占 ' + fmt(keptDetailBytes + droppedDetailBytes));
  console.log('    ├ 保留(4字段) : ' + fmt(keptDetailBytes));
  console.log('    └ 裁剪(其余)  : ' + fmt(droppedDetailBytes) + '  ← 查询页不读取');
  console.log('');
  console.log('  预计优化后    : ~' + fmt(outSizeEst) + '   (降幅 ' + ((1 - outSizeEst / sizeBefore) * 100).toFixed(1) + '%)');
  console.log('');

  if (DRY) { console.log('（--dry 模式，未写入任何文件）'); return; }

  /* ── 第二遍：写出优化后文件（保持原始行序，字节最小化） ───────── */
  /* 为保持与原文件一致的行序，先记录每个 uid 命中的最早行号对应的 uid 顺序 */
  const order = [];
  {
    const rl2 = readline.createInterface({
      input: fs.createReadStream(JSONL, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
    const keep = new Map();
    for await (const raw of rl2) {
      const line = raw.trim();
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      const uid = String(o.uid);
      const chosen = latest.get(uid);
      if (chosen && chosen.line === line) { keep.set(uid, o); order.push(uid); }
    }
    if (keep.size !== uniqMembers) {
      console.error('一致性校验失败：写出候选 ' + keep.size + ' ≠ 唯一 uid ' + uniqMembers);
      process.exit(1);
    }
    var KEEPED = keep;
  }

  const tmp = OUT + '.tmp';
  const ws = fs.createWriteStream(tmp, { encoding: 'utf8' });
  let written = 0;
  for (const uid of order) {
    const o = KEEPED.get(uid);
    /* 剥离冗余：summary 全删；detail 只留查询页用的 4 个子字段 */
    if (Array.isArray(o.orders)) {
      for (const ord of o.orders) {
        if (ord.summary !== undefined) delete ord.summary;
        if (ord.detail && typeof ord.detail === 'object') {
          for (const dk of Object.keys(ord.detail)) {
            if (!KEEP_DETAIL.has(dk)) delete ord.detail[dk];
          }
        }
      }
    }
    ws.write(JSON.stringify(o) + '\n');
    written++;
  }
  await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));

  const sizeAfter = fs.statSync(tmp).size;

  /* ── 校验：写回后重新解析，确认结构与关键计数不变 ─────────────── */
  let vLines = 0, vBad = 0, vOrders = 0, vSummary = 0, vDetailKeys = new Set();
  const vrl = readline.createInterface({ input: fs.createReadStream(tmp, { encoding: 'utf8' }), crlfDelay: Infinity });
  const vMembers = new Set();
  for await (const line of vrl) {
    if (!line.trim()) continue;
    vLines++;
    let o; try { o = JSON.parse(line); } catch (e) { vBad++; continue; }
    vMembers.add(String(o.uid));
    const arr = Array.isArray(o.orders) ? o.orders : [];
    vOrders += arr.length;
    for (const ord of arr) {
      if (ord.summary !== undefined) vSummary++;
      if (ord.detail) Object.keys(ord.detail).forEach(k => vDetailKeys.add(k));
    }
  }

  console.log('════════ 优化后校验 ════════');
  console.log('  写出文件      : ' + OUT);
  console.log('  优化后大小    : ' + fmt(sizeAfter) + '   降幅 ' + ((1 - sizeAfter / sizeBefore) * 100).toFixed(1) + '%');
  console.log('  行数 / 解析失败 : ' + vLines + ' / ' + vBad);
  console.log('  唯一 uid      : ' + vMembers.size + (vMembers.size === uniqMembers ? '  ✓' : '  ✗'));
  console.log('  残留 summary  : ' + vSummary + (vSummary === 0 ? '  ✓' : '  ✗'));
  console.log('  detail 保留字段: [' + [...vDetailKeys].join(', ') + ']');
  console.log('');

  /* 关键正确性标准：唯一 orderid 集合必须完整。
     行级累加值会下降（orders: 原 ' + orders + ' → 去重后 ' + vOrders + '），
     因为原文件把同 uid 的多行累加了——而 build_viewer 的 order_map[uid] 是
     覆盖式赋值、查询页分片也按 uid 去重，两处一直走的是「唯一订单」口径。
     这里的 18241 vs 17572 正是历史上「控制中心订单数虚高、与查询页对不上」的根因。 */
  const idsKeep = new Set();
  {
    const r2 = readline.createInterface({ input: fs.createReadStream(tmp, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of r2) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      for (const ord of (Array.isArray(o.orders) ? o.orders : [])) {
        if (ord && ord.orderid != null) idsKeep.add(String(ord.orderid));
      }
    }
  }
  const lostIds = [...idsAll].filter(x => !idsKeep.has(x));
  console.log('  唯一 orderid  : ' + idsKeep.size + ' / 原 ' + idsAll.size +
    (lostIds.length === 0 && idsKeep.size === idsAll.size ? '  ✓ 无订单丢失' : '  ✗ 丢失 ' + lostIds.length));
  if (lostIds.length) console.log('    丢失示例: ' + lostIds.slice(0, 5).join(', '));
  console.log('  行级累加订单数: ' + orders + ' → ' + vOrders +
    '  （消除同uid重复计数，与查询页分片口径对齐）');
  console.log('');
  const ok = vBad === 0 && vMembers.size === uniqMembers && vSummary === 0
    && lostIds.length === 0 && idsKeep.size === idsAll.size;
  console.log(ok ? '  ✓ 全部校验通过' : '  ✗ 校验未通过，请勿替换原文件');

  if (!ok) { fs.unlinkSync(tmp); process.exit(1); }

  /* ── 备份并替换 ─────────────────────────────────────────────── */
  fs.renameSync(JSONL, BAK);
  fs.renameSync(tmp, JSONL);
  console.log('');
  console.log('  原文件已备份为 : ' + BAK);
  console.log('  新文件已就位   : ' + JSONL);
  console.log('');
  console.log('  如需回滚： node app/optimize_jsonl.mjs --restore');
}

if (args.includes('--restore')) {
  if (!fs.existsSync(BAK)) { console.error('未找到备份 ' + BAK + '，无需回滚'); process.exit(1); }
  fs.renameSync(BAK, JSONL);
  console.log('已回滚，' + JSONL + ' 恢复为优化前版本');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
