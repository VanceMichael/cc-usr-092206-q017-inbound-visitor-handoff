// 匿名堵点统计。
//
// 行业管理人员只能看到「通关 / 支付 / 接待」三类堵点的聚合结果：
// - 入口只接受无身份信号行：出现旅次编号、姓名、证件、联络码等字段一律拒收；
// - 信号到达时立即并入计数器，模块不保留任何明细行；
// - k-匿名：同一时间桶内样本数不足 k 的小群被抑制，只并入被抑制总量，
//   管理人员无法借小群反推出某一位游客的旅程。

import { BLOCKER_DOMAINS } from './catalog.js';

// 各环节归属的堵点视角。
const STAGE_DOMAIN = {
  visa_consult: 'clearance',
  document_check: 'clearance',
  payment_setup: 'payment',
  transfer: 'reception',
  reception: 'reception',
};

// 信号行允许的全部字段。
const ALLOWED_KEYS = new Set(['domain', 'stage_id', 'code', 'bucket']);

// 任何疑似身份字段都不允许出现在统计入口。
const FORBIDDEN_KEY = [
  'trip_relay_id', 'tripRelayId', 'package_id', 'consent_id',
  'name', 'passport', 'document_no', 'phone', 'email',
  'relay_channel_id', 'relayChannelId', 'visitor_id',
];

function timeBucket(date) {
  const d = date instanceof Date ? date : new Date(date);
  // 按天分桶：足够粗，无法与班次/座位等小群对齐。
  return d.toISOString().slice(0, 10);
}

// 由环节编码构造一个不含身份的统计信号。
export function blockerSignal(stageId, code, date = new Date()) {
  const domain = STAGE_DOMAIN[stageId];
  if (!domain) throw new Error(`未知环节：${stageId}`);
  if (!code || typeof code !== 'string') throw new Error('缺少堵点代码');
  return { domain, stage_id: stageId, code, bucket: timeBucket(date) };
}

export class AnonymizedDashboard {
  // k：最小匿名群阈值，默认 5。低于该值的桶+堵点组合不单独显示。
  constructor({ k = 5 } = {}) {
    this._k = k;
    // key = bucket|domain|code → count
    this._cells = new Map();
    this._rejected = 0;
  }

  ingest(row) {
    if (!row || typeof row !== 'object') {
      this._rejected++;
      throw new Error('统计信号必须是对象');
    }
    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key) || FORBIDDEN_KEY.includes(key)) {
        this._rejected++;
        throw new Error(`统计信号含禁止字段：${key}（统计入口不接受任何身份信息）`);
      }
    }
    if (!BLOCKER_DOMAINS[row.domain] || !row.code || !row.bucket) {
      this._rejected++;
      throw new Error('统计信号缺少有效的 domain/code/bucket');
    }
    const key = `${row.bucket}|${row.domain}|${row.code}`;
    this._cells.set(key, (this._cells.get(key) || 0) + 1);
    // 信号已并入计数器，原始行不保存。
    return { accepted: true };
  }

  ingestMany(rows) {
    let accepted = 0;
    for (const row of rows) {
      this.ingest(row);
      accepted++;
    }
    return { accepted, rejected: this._rejected };
  }

  // 输出聚合视图：只含达到 k 的单元 + 被抑制总量，无法回溯到个人。
  report() {
    const domains = Object.fromEntries(
      Object.keys(BLOCKER_DOMAINS).map((d) => [
        d,
        { domain_name: BLOCKER_DOMAINS[d], total: 0, shown: 0, suppressed: 0, buckets: [] },
      ]),
    );

    for (const [key, count] of this._cells) {
      const [bucket, domain, code] = key.split('|');
      const d = domains[domain];
      d.total += count;
      if (count >= this._k) {
        d.buckets.push({ bucket, code, count });
        d.shown += count;
      } else {
        d.suppressed += count;
      }
    }
    for (const d of Object.values(domains)) d.buckets.sort((a, b) => b.count - a.count);
    return { k: this._k, rejectedRows: this._rejected, domains };
  }
}
