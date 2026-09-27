// 面向文旅行业管理人员的匿名统计。
// 设计约束：只能写入聚合维度（日期、环节、堵点类型），
// 任何可能标识旅次或游客的字段都会被拒绝；报表只返回达到最小单元阈值的计数。

const AGGREGATE_KEYS = ['day', 'leg', 'type'];

export function createAnalytics({ minCellSize = 3 } = {}) {
  if (!Number.isInteger(minCellSize) || minCellSize < 2) {
    throw new Error('匿名统计的最小单元阈值不能小于 2');
  }
  const cells = new Map();
  return {
    minCellSize,
    record(dimensions) {
      const extra = Object.keys(dimensions).filter((key) => !AGGREGATE_KEYS.includes(key));
      if (extra.length > 0) {
        throw new Error(`匿名统计不接受可识别个人的维度: ${extra.join(',')}`);
      }
      const { day, leg, type } = dimensions;
      if (!day || !leg || !type) throw new Error('匿名统计缺少聚合维度');
      const key = `${day}|${leg}|${type}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    },
    report() {
      const rows = [];
      let suppressed = 0;
      for (const [key, count] of [...cells.entries()].sort()) {
        if (count < minCellSize) {
          suppressed += 1;
          continue;
        }
        const [day, leg, type] = key.split('|');
        rows.push({ day, leg, type, count });
      }
      return { rows, suppressed_cells: suppressed };
    },
  };
}

// 把旅次审计日志折算成匿名堵点计数，用于识别通关、支付与接待堵点。
// 只读取事件类型与环节，不携带旅次标识、假名引用或时间戳。
const BOTTLENECK_EVENTS = {
  payment_failed: () => ({ leg: 'payment', type: 'payment_failure' }),
  document_expired: () => ({ leg: 'entry', type: 'document_expired' }),
  provider_replaced: (detail) => ({ leg: detail?.leg ?? 'unknown', type: 'provider_replaced' }),
  itinerary_changed: () => ({ leg: 'itinerary', type: 'itinerary_change' }),
  handoff_withdrawn: (detail) => ({ leg: detail?.leg ?? 'unknown', type: 'handoff_withdrawn' }),
};

export function contributeTrip(analytics, trip, { day }) {
  for (const event of trip.audit) {
    const map = BOTTLENECK_EVENTS[event.type];
    if (!map) continue;
    analytics.record({ day, ...map(event.detail) });
  }
}
