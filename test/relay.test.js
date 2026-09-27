import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrip,
  grantConsent,
  revokeConsent,
  syncHandoffs,
  completeLeg,
  changeItinerary,
  splitCompanions,
  replaceProvider,
  recordPaymentOutcome,
  recordDocumentVerification,
  recordDocumentExpiry,
  purgeExpired,
  touristView,
} from '../src/relay.js';
import { PACKET_TTL_MS } from '../src/packets.js';

const T0 = 1_700_000_000_000;

function makeTrip() {
  return createTrip({
    traveler: { language: 'en', accessibilityNeeds: ['wheelchair'] },
    itinerary: [
      { leg: 'entry', providerId: 'border-assist', location: 'PVG T2', scheduledAt: T0 + 1_000 },
      { leg: 'payment', providerId: 'pay-help', location: 'arrival hall', scheduledAt: T0 + 2_000 },
      {
        leg: 'transport',
        providerId: 'shuttle-co',
        location: 'bus bay 3',
        scheduledAt: T0 + 3_000,
        details: { from: 'PVG', to: 'riverside scenic area', mode: 'shuttle' },
      },
      {
        leg: 'reception',
        providerId: 'scenic-desk',
        location: 'east gate',
        scheduledAt: T0 + 4_000,
        details: { site: 'riverside scenic area' },
      },
    ],
    companions: [{ id: 'c1' }, { id: 'c2' }],
    now: T0,
  });
}

function consentedTrip() {
  const trip = makeTrip();
  grantConsent(trip, { noticeVersion: 'notice-2026-09', now: T0 });
  recordDocumentVerification(trip, {
    documentType: 'passport',
    validUntil: '2027-01-01',
    expiresAt: T0 + 10_000,
    now: T0,
  });
  return trip;
}

function actionCodes(trip, now) {
  return touristView(trip, { now }).pending_actions.map((a) => a.code);
}

test('一次旅次按环节接力，游客始终知道下一联系人与待办', () => {
  const trip = consentedTrip();

  // 境外咨询与通关环节：只交接行程需求与旅行文件核验结果。
  let view = touristView(trip, { now: T0 });
  assert.equal(view.next_contact.provider_id, 'border-assist');
  assert.deepEqual(view.upcoming_share.categories, ['itinerary_needs', 'document_check']);

  const s1 = syncHandoffs(trip, { now: T0 });
  assert.equal(s1.dispatched.length, 1);
  assert.deepEqual(Object.keys(s1.dispatched[0].categories).sort(), ['document_check', 'itinerary_needs']);
  assert.equal(s1.dispatched[0].categories.itinerary_needs.party_size, 3);

  // 落地后求助移动支付：支付服务商拿不到通关资料。
  completeLeg(trip, 'entry', { now: T0 + 100 });
  const s2 = syncHandoffs(trip, { now: T0 + 100 });
  assert.deepEqual(Object.keys(s2.dispatched[0].categories).sort(), ['itinerary_needs', 'payment_help']);
  assert.equal(touristView(trip, { now: T0 + 100 }).next_contact.provider_id, 'pay-help');

  // 换乘与接待依次接力。
  recordPaymentOutcome(trip, { status: 'confirmed', method: 'wallet', now: T0 + 200 });
  completeLeg(trip, 'payment', { now: T0 + 200 });
  const s3 = syncHandoffs(trip, { now: T0 + 200 });
  assert.deepEqual(Object.keys(s3.dispatched[0].categories).sort(), ['itinerary_needs', 'transport_plan']);

  completeLeg(trip, 'transport', { now: T0 + 300 });
  const s4 = syncHandoffs(trip, { now: T0 + 300 });
  assert.equal(s4.dispatched[0].categories.reception_confirmation.payment_confirmed, true);
  view = touristView(trip, { now: T0 + 300 });
  assert.equal(view.next_contact.provider_id, 'scenic-desk');
  assert.deepEqual(view.pending_actions, []);
});

test('交接内容最小必要且不包含身份资料', () => {
  const trip = consentedTrip();
  const { dispatched } = syncHandoffs(trip, { now: T0 });
  const packet = dispatched[0];
  // 通关服务商拿不到支付、交通、接待类别。
  assert.ok(!('payment_help' in packet.categories));
  assert.ok(!('transport_plan' in packet.categories));
  assert.ok(!('reception_confirmation' in packet.categories));
  // 核验结果只含结论，不含证件号码；整包不出现姓名、证件号字段。
  assert.deepEqual(Object.keys(packet.categories.document_check).sort(), ['document_type', 'status', 'valid_until']);
  const raw = JSON.stringify(packet);
  assert.ok(!raw.includes('passport_no'));
  assert.ok(!raw.includes('name'));
  // 面向服务商的只是假名引用，且不同服务商拿到的引用不同。
  completeLeg(trip, 'entry', { now: T0 + 100 });
  const s2 = syncHandoffs(trip, { now: T0 + 100 });
  assert.notEqual(s2.dispatched[0].subject_ref, packet.subject_ref);
});

test('未取得明确同意前不发生任何共享', () => {
  const trip = makeTrip();
  recordDocumentVerification(trip, {
    documentType: 'passport',
    validUntil: '2027-01-01',
    expiresAt: T0 + 10_000,
    now: T0,
  });
  const result = syncHandoffs(trip, { now: T0 });
  assert.equal(result.dispatched.length, 0);
  assert.equal(trip.handoffs.length, 0);
  assert.ok(actionCodes(trip, T0).includes('grant_consent'));
});

test('授权范围之外的环节不共享', () => {
  const trip = makeTrip();
  grantConsent(trip, { scope: ['entry'], noticeVersion: 'notice-2026-09', now: T0 });
  recordDocumentVerification(trip, {
    documentType: 'passport',
    validUntil: '2027-01-01',
    expiresAt: T0 + 10_000,
    now: T0,
  });
  syncHandoffs(trip, { now: T0 });
  completeLeg(trip, 'entry', { now: T0 + 100 });
  const result = syncHandoffs(trip, { now: T0 + 100 });
  assert.equal(result.dispatched.length, 0);
  assert.deepEqual(result.withheld, [{ leg: 'payment', reason: 'consent_missing' }]);
});

test('撤回授权停止尚未发生的共享', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  revokeConsent(trip, { now: T0 + 50 });
  completeLeg(trip, 'entry', { now: T0 + 60 });
  const after = syncHandoffs(trip, { now: T0 + 60 });
  assert.equal(after.dispatched.length, 0);
  const dispatched = trip.handoffs.filter((h) => h.status === 'dispatched');
  assert.equal(dispatched.length, 1); // 只有撤回前已送达的通关交接
  assert.equal(touristView(trip, { now: T0 + 60 }).consent_status, 'revoked');
});

test('行程变动后交接随之收窄', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  completeLeg(trip, 'entry', { now: T0 + 100 });
  syncHandoffs(trip, { now: T0 + 100 });
  completeLeg(trip, 'payment', { now: T0 + 200 });
  syncHandoffs(trip, { now: T0 + 200 }); // 交通交接已送达 shuttle-co

  changeItinerary(
    trip,
    trip.itinerary.filter((item) => item.leg !== 'transport'),
    { now: T0 + 300 },
  );
  const transport = trip.handoffs.find((h) => h.leg === 'transport');
  assert.equal(transport.status, 'withdrawn');
  assert.ok(trip.notices.some((n) => n.type === 'withdraw' && n.provider_id === 'shuttle-co'));
});

test('同行人拆分后人数收窄并通知已送达的服务商', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  splitCompanions(trip, ['c1', 'c2'], { now: T0 + 10 });
  const entry = trip.handoffs.find((h) => h.leg === 'entry');
  assert.equal(entry.packet.categories.itinerary_needs.party_size, 1);
  const notice = trip.notices.find((n) => n.type === 'narrow' && n.provider_id === 'border-assist');
  assert.ok(notice.discard.includes('itinerary_needs.party_size'));
});

test('服务方替换时旧方收到撤回、新方只拿到当前所需', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  replaceProvider(trip, 'entry', 'border-assist-2', { now: T0 + 10 });
  assert.ok(trip.notices.some((n) => n.type === 'withdraw' && n.provider_id === 'border-assist'));
  const again = syncHandoffs(trip, { now: T0 + 20 });
  assert.equal(again.dispatched.length, 1);
  assert.equal(again.dispatched[0].provider_id, 'border-assist-2');
  assert.deepEqual(Object.keys(again.dispatched[0].categories).sort(), ['document_check', 'itinerary_needs']);
});

test('付款失败收窄接待交接并给出游客待办', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  completeLeg(trip, 'entry', { now: T0 + 100 });
  recordPaymentOutcome(trip, { status: 'confirmed', method: 'wallet', now: T0 + 150 });
  completeLeg(trip, 'payment', { now: T0 + 150 });
  syncHandoffs(trip, { now: T0 + 200 });
  completeLeg(trip, 'transport', { now: T0 + 250 });
  syncHandoffs(trip, { now: T0 + 300 }); // 接待交接已送达，payment_confirmed: true

  recordPaymentOutcome(trip, { status: 'failed', reason: 'card_declined', now: T0 + 400 });
  const reception = trip.handoffs.find((h) => h.leg === 'reception');
  assert.equal(reception.packet.categories.reception_confirmation.payment_confirmed, false);
  assert.ok(trip.notices.some((n) => n.type === 'narrow' && n.provider_id === 'scenic-desk'));
  assert.ok(actionCodes(trip, T0 + 400).includes('retry_payment'));

  // 支付环节重新打开，游客回到支付服务商，交接只带失败上下文。
  const view = touristView(trip, { now: T0 + 400 });
  assert.equal(view.next_contact.provider_id, 'pay-help');
  const again = syncHandoffs(trip, { now: T0 + 400 });
  assert.equal(again.dispatched[0].categories.payment_help.status, 'failed');
  assert.equal(again.dispatched[0].categories.payment_help.failure_reason, 'card_declined');
});

test('证件过期后通关交接暂扣，重新核验后恢复', () => {
  const trip = consentedTrip();
  recordDocumentExpiry(trip, { now: T0 + 5 });
  const withheld = syncHandoffs(trip, { now: T0 + 5 });
  assert.equal(withheld.dispatched.length, 0);
  assert.deepEqual(withheld.withheld, [{ leg: 'entry', reason: 'document_check_missing' }]);
  assert.ok(actionCodes(trip, T0 + 5).includes('refresh_document_check'));

  recordDocumentVerification(trip, {
    documentType: 'passport',
    validUntil: '2027-06-01',
    expiresAt: T0 + 50_000,
    now: T0 + 6,
  });
  const resumed = syncHandoffs(trip, { now: T0 + 6 });
  assert.equal(resumed.dispatched.length, 1);
});

test('证件过期收窄已送达的通关交接', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });
  recordDocumentExpiry(trip, { now: T0 + 5 });
  const entry = trip.handoffs.find((h) => h.leg === 'entry');
  assert.ok(!('document_check' in entry.packet.categories));
  const notice = trip.notices.find((n) => n.type === 'narrow' && n.provider_id === 'border-assist');
  assert.ok(notice.discard.includes('document_check'));
});

test('敏感资料到期失效', () => {
  const trip = consentedTrip();
  syncHandoffs(trip, { now: T0 });

  // 核验结论到期：状态失效，已送达交接中的核验结果被收窄。
  purgeExpired(trip, { now: T0 + 20_000 });
  assert.equal(trip.documents.verification.status, 'expired');
  const entry = trip.handoffs.find((h) => h.leg === 'entry');
  assert.ok(!('document_check' in entry.packet.categories));

  // 交接包本身到期：作废并通知服务商。
  purgeExpired(trip, { now: T0 + PACKET_TTL_MS + 1 });
  assert.equal(entry.status, 'expired');
  assert.ok(trip.notices.some((n) => n.type === 'expire' && n.provider_id === 'border-assist'));
});
