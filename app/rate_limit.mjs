#!/usr/bin/env node
/* ============================================================
 * 洗衣管家 · 统一限速器（rate_limit.mjs）
 * ------------------------------------------------------------
 * 背景：
 *   洗衣管家服务端有风控。短时间内大量请求会导致接口「冷却」不响应，
 *   严重时直接把当前登录账号踢下线，影响门店正常营业。因此所有对
 *   洗衣管家的取数请求都必须经过本限速器。
 *
 * 两层保护：
 *   1) 最小间隔 + 随机抖动：相邻两次接口调用至少间隔 minIntervalMs，
 *      再叠加 0~jitterMs 的随机抖动，避免「机械等间隔」这种明显的
 *      机器特征；
 *   2) 指数退避：由调用方根据失败次数拉长休息时长（本模块提供
 *      backoffSeconds 工具函数）。
 *
 * 串行化：
 *   acquire() 内部通过 Promise 链串行化：即使调用方并发触发
 *   （如 Promise.all / 未 await 的调用），也能保证「检查—等待—记账」
 *   这段临界区不被重入。
 *
 * 说明：已按要求移除「每小时请求次数上限」配额，以及为跨进程共享该配额
 *   而存在的状态文件记账。请求节奏完全由 minIntervalMs / jitterMs 决定。
 *
 * 只读说明：本模块不读写任何外部状态文件，不对洗衣管家发起任何写操作。
 * ============================================================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从环境变量读取正整数。
 * @param {string} name 环境变量名
 * @param {number} fallback 缺省值
 * @returns {number} 解析结果（非法值时返回 fallback）
 */
export function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 从命令行参数读取 `--name=值` 形式的数字。
 * @param {string[]} argv 参数数组
 * @param {string} name 参数名（不含 `--`）
 * @param {number} fallback 缺省值
 * @returns {number} 解析结果（非法值时返回 fallback）
 */
export function argNum(argv, name, fallback) {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (typeof a === 'string' && a.startsWith(prefix)) {
      const n = Number(a.slice(prefix.length).trim());
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return fallback;
}

/**
 * 综合「默认值 < 环境变量 < 命令行参数」的优先级读取一个数值配置。
 * @param {object} opts 配置描述
 * @param {string[]} opts.argv 命令行参数数组
 * @param {string} opts.arg 命令行参数名
 * @param {string} opts.env 环境变量名
 * @param {number} opts.def 默认值
 * @returns {number} 最终生效值
 */
export function pickNum({ argv, arg, env, def }) {
  const base = envNum(env, def);
  return argNum(argv, arg, base);
}

/**
 * 指数退避秒数：第 n 次失败时返回 min(base * 2^(n-1), max) 秒。
 * @param {number} attempt 当前是第几次失败（从 1 开始）
 * @param {number} base 基础秒数
 * @param {number} max 上限秒数
 * @returns {number} 需要等待的秒数
 */
export function backoffSeconds(attempt, base, max) {
  const n = Math.max(1, Number(attempt) || 1);
  const v = base * Math.pow(2, n - 1);
  return Math.round(Math.min(max, Math.max(base, v)));
}

/**
 * 统一限速器。
 * 用法：
 *   const limiter = new RateLimiter({ name: '会员详情', minIntervalMs: 2200, jitterMs: 1000 });
 *   await limiter.acquire();   // 每次对洗衣管家发起请求前调用
 */
export class RateLimiter {
  /**
   * @param {object} [opts] 配置项
   * @param {string} [opts.name='api'] 名称，用于日志
   * @param {number} [opts.minIntervalMs=2000] 相邻请求最小间隔（毫秒）
   * @param {number} [opts.jitterMs=800] 额外随机抖动上限（毫秒）
   * @param {(line: string) => void} [opts.log] 日志函数
   */
  constructor(opts = {}) {
    this.name = opts.name || 'api';
    this.minIntervalMs = Math.max(0, Number(opts.minIntervalMs) || 0);
    this.jitterMs = Math.max(0, Number(opts.jitterMs) || 0);
    this.log = typeof opts.log === 'function' ? opts.log : () => { /* 静默 */ };
    this.lastAt = 0;
    this.total = 0;
    /** @type {Promise<unknown>} 串行链：保证同一实例内的 acquire() 严格逐个排队执行 */
    this._chain = Promise.resolve();
  }

  /**
   * 获取一次请求许可：等待最小间隔 + 抖动后放行。
   * 内部通过 _chain 串行化：即使调用方并发触发（如 Promise.all / 未 await 的调用），
   * 也能保证「检查—等待—记账」这段临界区不被重入。
   * @returns {Promise<void>}
   */
  acquire() {
    const run = this._chain.then(() => this._acquireOnce());
    /* 串行链本身吞掉异常，避免单次失败污染后续排队者；调用方仍会收到本次的 reject */
    this._chain = run.catch(() => { /* ignore */ });
    return run;
  }

  /**
   * acquire() 的实际实现（已在 _chain 保护下串行执行，无需额外加锁）。
   * @returns {Promise<void>}
   */
  async _acquireOnce() {
    /* 最小间隔 + 抖动 */
    const target = this.lastAt + this.minIntervalMs + Math.floor(Math.random() * (this.jitterMs + 1));
    const waitMs = target - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    this.lastAt = Date.now();
    this.total++;
  }

  /**
   * 已发请求数描述，便于日志展示。
   * @returns {string} 例如「本次已发 123 次」
   */
  usage() {
    return `本次已发 ${this.total} 次`;
  }
}
