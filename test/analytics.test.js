import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics, contributeTrip } from '../src/analytics.js';
import {
  createTrip,
  grantConsent,
  recordPaymentOutcome,
  recordDocumentExpiry,
  replaceProvider,
} from '../src/relay.js';

const T0 = 1_700_000_000_000;
const DAY = '2026-09-27';

function makeTrip() {
  const trip = createTrip({
    traveler: { language: 'en', accessibilityNeeds: [] },
    itinerary: [
      { leg: 'entry', providerId: 'border-assist', location: 'PVG T2', scheduledAt: T0 },
      { leg: 'payment', providerId: 'pay-help', location: 'hall', scheduledAt: T0 },
    ],
    now: T0,
  });
  grantConsent(trip, { noticeVersion: 'notice-2026-09', now: T0 });
  return trip;
}

test('行业统计只呈现匿名聚合，无法查看个人旅程', () => {
  const analytics = createAnalytics({ minCellSize: 2 });

  // 三起支付失败、两起证件过期：达到阈值，进入报表。
  for (let i = 0; i < 3; i += 1) {
    const trip = makeTrip();
    recordPaymentOutcome(trip, { status: 'failed', reason: 'card_declined', now: T0 + i });
    contributeTrip(analytics, trip, { day: DAY });
  }
  for (let i = 0; i < 2; i += 1) {
    const trip = makeTrip();
    recordDocumentExpiry(trip, { now: T0 + i });
    contributeTrip(analytics, trip, { day: DAY });
  }
  // 一起服务方替换：低于阈值，被抑制。
  const lone = makeTrip();
  replaceProvider(lone, 'entry', 'border-assist-2', { now: T0 });
  contributeTrip(analytics, lone, { day: DAY });

  const { rows, suppressed_cells } = analytics.report();
  assert.deepEqual(rows, [
    { day: DAY, leg: 'entry', type: 'document_expired', count: 2 },
    { day: DAY, leg: 'payment', type: 'payment_failure', count: 3 },
  ]);
  assert.equal(suppressed_cells, 1);

  // 报表中只有聚合维度与计数，不出现任何旅次标识。
  const raw = JSON.stringify(rows);
  assert.ok(!raw.includes(lone.id));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['count', 'day', 'leg', 'type']);
  }
});

test('匿名统计拒绝可识别个人的维度', () => {
  const analytics = createAnalytics();
  assert.throws(
    () => analytics.record({ day: DAY, leg: 'payment', type: 'payment_failure', tripId: 'x' }),
    /可识别个人/,
  );
  assert.throws(() => createAnalytics({ minCellSize: 1 }), /最小单元阈值/);
});
