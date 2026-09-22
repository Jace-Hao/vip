# -*- coding: utf-8 -*-
"""
洗衣管家会员导出 · 查询页面数据生成（build_viewer.py）
将 导出结果 里最新的「会员全量数据 + 会员详情」合并生成
查询页面/data.js（供 查询页面/index.html 离线查询使用）。

用法：python build_viewer.py [--out 目录]
"""
import glob
import json
import os
import re
import sys
from datetime import datetime

# 字段中文名（与 export.mjs 保持一致；如导出 JSON 内携带 fullLabels 则优先使用）
FALLBACK_LABELS = {
    "uid": "会员ID", "groupid": "集团ID", "topid": "商户ID", "pshopid": "上级门店ID", "shopid": "门店ID",
    "corpid": "企业ID", "cid": "客户ID", "suid": "关联用户ID", "score": "积分", "vipid": "会员级别ID",
    "plusid": "PLUS会员ID", "type": "渠道类型(1店内2公众号)", "isbind": "公众号绑定(1已绑0未绑)", "status": "状态(0正常1禁用)",
    "onum": "累计订单数", "ocnum": "累计订单件数", "ormb": "累计订单金额·分", "crmb": "累计充值·分", "zrmb": "累计赠送·分",
    "cnum": "卡张数", "cardnum": "会员卡号", "cardrmb": "会员卡余额·分", "balance": "账户余额·分",
    "b_crmb": "余额-充值部分·分", "b_zrmb": "余额-赠送部分·分", "sex": "性别", "age": "年龄", "birth": "生日",
    "nick": "昵称", "logo": "头像", "name": "姓名", "py": "姓名拼音", "phone": "手机号", "rphone": "手机号-倒序",
    "ip": "最后登录IP", "tagids": "标签ID", "note": "备注", "birthday": "生日时间", "otime": "最近动态时间",
    "mtime": "最后修改时间", "ctime": "注册时间", "source": "来源", "vip_name": "会员级别名称", "vipname": "级别名称",
    "vip_cut": "折扣值", "cut": "折扣值2", "sname": "所属门店", "oldvipid": "原级别ID",
    "address": "地址", "province": "省ID", "city": "市ID", "county": "区县ID",
    "province_name": "省", "city_name": "市", "county_name": "区县",
    "zbalance": "赠送余额·分", "cbalance": "充值余额·分", "corpname": "企业名称", "scorermb": "积分金额·分",
    "tagname": "标签名称", "chargeno": "最近充值单号", "chargeshop": "最近充值门店",
    "chargetime": "最近充值时间", "chargermb": "最近充值金额·分", "edate": "到期日期",
    "hcard": "充值卡", "vipcard": "VIP卡", "ticket": "优惠券", "order": "订单明细", "plusnot": "PLUS明细",
}


def latest_file(out_dir, pattern, need_key=None):
    files = glob.glob(os.path.join(out_dir, pattern))
    files.sort(key=os.path.getmtime, reverse=True)
    for f in files:
        if need_key:
            try:
                with open(f, encoding='utf-8') as fp:
                    d = json.load(fp)
                if not d.get(need_key):
                    continue
            except Exception:
                continue
        return f
    return None


def header_to_key(h):
    m = re.search(r'（([^（）]+)）\s*$', h)
    return m.group(1) if m else h


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(base)
    out_dir = os.path.join(root, '导出结果')
    view_dir = os.path.join(root, '查询页面')

    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--out' and i + 1 < len(args):
            view_dir = args[i + 1]

    if not os.path.isdir(out_dir):
        print('[错误] 未找到 导出结果 目录，请先完成一次导出。')
        return 1

    # 1) 会员全量数据（取最新的、含 fullRows 的导出 JSON）
    main_json = latest_file(out_dir, '会员导出_*.json', need_key='fullRows')
    if not main_json:
        print('[错误] 未找到含全量字段的导出文件（会员导出_*.json）。请先运行一次导出。')
        return 1
    with open(main_json, encoding='utf-8') as f:
        data = json.load(f)

    headers = data.get('fullHeaders') or []
    rows = data.get('fullRows') or []
    keys = [header_to_key(h) for h in headers]
    members = []
    for r in rows:
        m = {}
        for i, k in enumerate(keys):
            m[k] = r[i] if i < len(r) else ''
        members.append(m)

    labels = data.get('fullLabels') or FALLBACK_LABELS
    result = {
        'generatedAt': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'shop': data.get('shop') or '',
        'softwareVersion': data.get('softwareVersion') or '',
        'exportStamp': os.path.basename(main_json).replace('会员导出_', '').replace('.json', ''),
        'sourceJson': os.path.basename(main_json),
        'labels': labels,
        'members': members,
        'details': {},
    }

    # 2) 会员详情（最新的详情 JSON + 未完成的续传记录 jsonl，后者优先）
    details = {}
    det_json = latest_file(out_dir, '会员详情_*.json')
    det_ok = 0
    det_errors = 0
    if det_json:
        try:
            with open(det_json, encoding='utf-8') as f:
                dj = json.load(f)
            det_ok = dj.get('ok') or 0
            det_errors = dj.get('errorCount') or 0
            for d in (dj.get('details') or []):
                if d and d.get('uid') is not None:
                    details[str(d['uid'])] = d
        except Exception as e:
            print('[提示] 详情 JSON 读取失败：', e)

    jsonl = os.path.join(out_dir, '.deep_results.jsonl')
    jsonl_add = 0
    if os.path.exists(jsonl):
        with open(jsonl, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                    if o and o.get('uid') is not None and o.get('detail'):
                        details[str(o['uid'])] = o['detail']
                        jsonl_add += 1
                except Exception:
                    pass  # 忽略半行/异常行

    result['details'] = details
    result['counts'] = {
        'members': len(members),
        'details': len(details),
        'detailsFromJson': det_ok,
        'detailsFromJsonl': jsonl_add,
        'detailErrors': det_errors,
    }

    os.makedirs(view_dir, exist_ok=True)
    out_js = os.path.join(view_dir, 'data.js')
    txt = 'window.MEMBER_DATA=' + json.dumps(result, ensure_ascii=False, separators=(',', ':')) + ';'
    with open(out_js, 'w', encoding='utf-8') as f:
        f.write(txt)

    print('数据已生成：', out_js)
    print('  会员：%d 人 | 详情：%d 人（其中 JSON %d + 续传记录 %d）' % (len(members), len(details), det_ok, jsonl_add))
    if det_json:
        print('  详情文件：', os.path.basename(det_json), ('（含 %d 条失败记录可续传补抓）' % det_errors) if det_errors else '')
    print('  源数据：', os.path.basename(main_json))
    return 0


if __name__ == '__main__':
    sys.exit(main())
