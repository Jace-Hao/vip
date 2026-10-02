#!/usr/bin/env node
/* ============================================================
 * 会员组别过滤（group_filter.mjs）
 * ------------------------------------------------------------
 * 用途：仅同步「会员组别 == 目标组别」的会员数据。
 *   洗衣管家会员列表接口返回的组别字段为 vip_name（会员级别名称），
 *   同义字段 vipname（级别名称）与之恒等，作为缺失时的回退。
 *
 * 目标组别：默认 "VIP会员"，可用环境变量 LAUNDRY_VIP_GROUP 覆盖
 *   （例如某些门店把该组别命名为 "VIP" 时，设 LAUNDRY_VIP_GROUP=VIP 即可，
 *    无需改代码）。
 *
 * 边界处理（默认策略）：
 *   - 字段缺失 / 空值        → 排除（保守：无法确认是目标组别就不纳入，宁缺毋漏）
 *   - 大小写差异（vip会员）  → 标准化为小写后精确比较，命中
 *   - 前后/内部空格差异      → 去前后空格、合并内部空格后比较，命中
 *   - 多种命名格式（"VIP会员" / "vip 会员" / "VIP会员 "）
 *                            → 经标准化后均等同 "vip会员"，命中
 *
 * 注意：采用「标准化后精确匹配」，不会做子串/模糊匹配，
 *   因此 "VIP"（缺少「会员」二字）这类**不同**的组别名会被正确排除。
 * ============================================================ */
import process from 'node:process';

/** 目标会员组别（可被环境变量覆盖） */
export const TARGET_GROUP = (process.env.LAUNDRY_VIP_GROUP || 'VIP会员');

/**
 * 标准化组别值：去除所有空白字符（含前后与内部空格）、转小写。
 * 空值 / undefined / null 一律返回空串 ''，调用方据此判定「缺失/空值」。
 * 去除全部空白可兼容 "VIP会员" / "vip 会员" / "VIP会员 " 等大小写与空格变体。
 */
export function normalizeGroup(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, '').toLowerCase();
}

const TARGET_GROUP_NORM = normalizeGroup(TARGET_GROUP);

/**
 * 判断单个会员是否属于目标组别。
 * @param {object} member 会员对象（字段 vip_name / vipname）
 * @returns {boolean}
 */
export function isTargetGroup(member) {
  if (!member || typeof member !== 'object') return false;
  /* 优先取 vip_name；缺失/空时回退到同义的 vipname */
  const raw = (member.vip_name !== undefined && member.vip_name !== null && member.vip_name !== '')
    ? member.vip_name
    : (member.vipname !== undefined && member.vipname !== null ? member.vipname : '');
  const norm = normalizeGroup(raw);
  if (norm === '') return false; // 字段缺失 / 空值 → 默认排除
  return norm === TARGET_GROUP_NORM; // 标准化后精确匹配
}
