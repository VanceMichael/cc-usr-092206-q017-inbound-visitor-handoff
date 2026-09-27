import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayService, RelayError } from '../src/relay.js';
import { AnonymizedDashboard, blockerSignal } from '../src/analytics.js';
import { FIELD_GROUPS, STAGES } from '../src/catalog.js';

const DAY = 24 * 60 * 60 * 1000;

function clocked() {
  let t = new Date('2026-09-20T08:00:00Z');
  const svc = new RelayService(() => t);
  return {
    svc,
    now: () => t,
    advance: (ms) => { t = new Date(t.getTime() + ms); },
  };
}

const ALL_GROUPS = ['trip_needs', 'doc_verification', 'payment_help', 'transport_arrangement', 'reception_confirmation', 'relay_contact'];

function seedTrip(svc) {
  const id = svc.createTrip();
  svc.recordTripNeeds(id, { languages: ['英语'], accessibility: '轮椅坡道', passport_number: 'XXX' });
  svc.recordVerification(id, { document_status: 'valid', visa_type: 'L', valid_until: '2026-10-20T00:00:00Z', verification_ref: 'vr-1' });
  svc.recordGroup(id, 'payment_help', { preferred_channels: ['卡'], help_status: 'pending' });
  svc.recordGroup(id, 'transport_arrangement', { route: '机场→换乘点', scheduled_at: '2026-09-22T10:00:00Z', seats: 4, accessible_vehicle: true });
  svc.recordGroup(id, 'reception_confirmation', { site: '云湖', booking_ref: 'BK-1', scheduled_at: '2026-09-22T11:00:00Z', party_size: 4 });
  return id;
}

function consent(svc, id, groups = ALL_GROUPS) {
  return svc.grantConsent(id, { groups, explicit: true }).consentId;
}

function handoff(svc, id) {
  const pkg = svc.prepareHandoff(id);
  return svc.deliverPackage(id, pkg.package_id);
}

test('白名单外的身份字段在入库时即丢弃', () => {
  const { svc } = clocked();
  const id = svc.createTrip();
  const saved = svc.recordTripNeeds(id, { languages: ['英语'], passport_number: 'P123', phone: '13900000000' });
  assert.deepEqual(Object.keys(saved).sort(), ['languages']);
});

test('没有明确授权不能交接；非显式同意被拒', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  assert.throws(() => svc.prepareHandoff(id), (e) => e.code === 'NOTHING_TO_HANDOFF');
  assert.throws(() => svc.grantConsent(id, { groups: ['trip_needs'], explicit: false }),
    (e) => e.code === 'CONSENT_NOT_EXPLICIT');
  consent(svc, id);
  const pkg = svc.prepareHandoff(id);
  assert.equal(pkg.status, 'active');
});

test('每个环节只拿到矩阵规定的最小必要分组', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);

  const p1 = handoff(svc, id);
  assert.deepEqual(Object.keys(p1.groups), ['trip_needs']);
  svc.completeStage(id);

  const p2 = handoff(svc, id);
  assert.deepEqual(Object.keys(p2.groups), ['trip_needs']);
  svc.completeStage(id);

  const p3 = handoff(svc, id);
  assert.deepEqual(Object.keys(p3.groups).sort(), ['payment_help', 'relay_contact', 'trip_needs']);
  svc.completeStage(id);

  const p4 = handoff(svc, id);
  assert.deepEqual(Object.keys(p4.groups).sort(), ['doc_verification', 'relay_contact', 'transport_arrangement', 'trip_needs']);
  assert.ok(!('visa_type' in p4.groups.trip_needs));
});

test('未授权的分组从交接包中剔除并在 dropped 中说明', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id, ['trip_needs', 'transport_arrangement', 'relay_contact']); // 不授权核验结果
  handoff(svc, id); svc.completeStage(id);
  handoff(svc, id); svc.completeStage(id);
  handoff(svc, id); svc.completeStage(id);
  const pkg = svc.prepareHandoff(id);
  assert.ok(!pkg.groups.doc_verification);
  assert.ok(pkg.dropped.some((d) => d.group === 'doc_verification' && d.reason === 'no_consent'));
});

test('付款失败后支付交接收窄为重试字段，恢复后还原', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  handoff(svc, id); svc.completeStage(id);
  handoff(svc, id); svc.completeStage(id);

  svc.paymentFailed(id);
  const pkg = svc.prepareHandoff(id);
  assert.deepEqual(Object.keys(pkg.groups.payment_help).sort(), ['help_status', 'retry_required']);
  assert.equal(pkg.groups.payment_help.retry_required, true);
  assert.equal(pkg.narrowing_reason, 'payment_failed');

  const card = svc.relayCard(id);
  assert.equal(card.nextContact.providerId, 'payment-provider');
  assert.match(card.todos[0], /重试/);

  svc.paymentRecovered(id);
});

test('行程变动后尚未交付的交接包作废，重发按新数据', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  for (let i = 0; i < 3; i++) { handoff(svc, id); svc.completeStage(id); }

  const stale = svc.prepareHandoff(id);
  svc.applyItineraryChange(id, { transportPatch: { scheduled_at: '2026-09-22T08:00:00Z' } });
  assert.throws(() => svc.deliverPackage(id, stale.package_id), (e) => e.code === 'PACKAGE_BLOCKED');

  const fresh = handoff(svc, id);
  assert.equal(fresh.groups.transport_arrangement.scheduled_at, '2026-09-22T08:00:00Z');
});

test('同行人拆分下调座位与人数', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  const r = svc.splitParty(id, { seatsRemove: 3, partySizeRemove: 2 });
  assert.equal(r.seats, 1);
  assert.equal(r.partySize, 2);
});

test('服务方替换撤回未交付给旧方的包，重发指向新方', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  for (let i = 0; i < 3; i++) { handoff(svc, id); svc.completeStage(id); }
  handoff(svc, id); svc.completeStage(id); // 交通完成，待接待

  const old = svc.prepareHandoff(id);
  assert.equal(old.provider_id, 'scenic-reception');
  svc.replaceProvider(id, 'reception', 'scenic-reception-b');
  assert.throws(() => svc.deliverPackage(id, old.package_id), (e) => e.code === 'PACKAGE_BLOCKED');

  const next = svc.prepareHandoff(id);
  assert.equal(next.provider_id, 'scenic-reception-b');
});

test('证件过期后下游交接移除核验结果并要求重新核验', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  for (let i = 0; i < 3; i++) { handoff(svc, id); svc.completeStage(id); }

  svc.documentExpired(id);
  const card = svc.relayCard(id);
  assert.equal(card.nextContact.providerId, 'visa-service');
  assert.match(card.alerts[0], /失效/);

  // 交通环节不再带核验结果。
  const pkg = svc.prepareHandoff(id);
  assert.ok(!pkg.groups.doc_verification);
  assert.ok(pkg.dropped.some((d) => d.group === 'doc_verification' && d.reason === 'document_expired'));
});

test('sweep 按 valid_until 自动判定证件过期', () => {
  const c = clocked();
  const id = seedTrip(c.svc);
  consent(c.svc, id);
  c.svc.recordVerification(id, { document_status: 'valid', valid_until: '2026-09-21T00:00:00Z', verification_ref: 'vr-2' });
  c.advance(2 * DAY);
  const report = c.svc.sweep();
  assert.ok(report.documentsExpired.includes(id));
});

test('撤回授权停止尚未发生的共享，已交付的保留到 TTL', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  handoff(svc, id); svc.completeStage(id);

  const pending = svc.prepareHandoff(id);
  svc.revokeConsent(id);
  assert.equal(svc.getPackage(id, pending.package_id).status, 'revoked');
  assert.throws(() => svc.deliverPackage(id, pending.package_id), (e) => e.code === 'PACKAGE_BLOCKED');
  assert.throws(() => svc.prepareHandoff(id), (e) => e.code === 'NOTHING_TO_HANDOFF');

  // 按组撤回只影响该组。
  const id2 = seedTrip(svc);
  consent(svc, id2);
  svc.revokeConsent(id2, { groups: ['doc_verification'] });
  handoff(svc, id2); svc.completeStage(id2);
  const pkg = svc.prepareHandoff(id2);
  assert.ok(pkg.groups.trip_needs);
  assert.ok(!pkg.groups.doc_verification);
});

test('敏感资料到 TTL 被抹除，交接包失效', () => {
  const c = clocked();
  const id = seedTrip(c.svc);
  consent(c.svc, id);
  const first = handoff(c.svc, id); // 境外咨询：trip_needs（无 TTL）
  c.svc.completeStage(id);
  handoff(c.svc, id); c.svc.completeStage(id); // 文件核验
  handoff(c.svc, id); c.svc.completeStage(id); // 支付帮助（7 天 TTL）
  const transferPkg = handoff(c.svc, id);       // 换乘：核验结果在此首次交付（30 天 TTL）

  c.advance(31 * DAY);
  const report = c.svc.sweep();
  assert.ok(report.erased.some((e) => e.group === 'doc_verification'));
  assert.ok(report.erased.some((e) => e.group === 'payment_help'));
  assert.equal(c.svc.getPackage(id, transferPkg.package_id).status, 'expired');
  // trip_needs 不设 TTL，仍可用于后续环节。
  assert.ok(first.groups.trip_needs);
  assert.equal(FIELD_GROUPS.doc_verification.ttlMs, 30 * DAY);
});

test('旅次关闭后抹除采集内容', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  handoff(svc, id);
  svc.closeTrip(id);
  assert.throws(() => svc.prepareHandoff(id), (e) => e.code === 'TRIP_CLOSED');
});

test('接力卡始终给出下一联系人与待办', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  const card0 = svc.relayCard(id);
  assert.equal(card0.nextContact.providerId, 'ota-overseas');
  assert.ok(card0.nextContact.viaChannelId.startsWith('ch-'));
  assert.equal(card0.sharedHistory.length, 0);

  handoff(svc, id); svc.completeStage(id);
  const card1 = svc.relayCard(id);
  assert.equal(card1.nextContact.providerId, 'visa-service');
  assert.equal(card1.sharedHistory.length, 1);
});

test('环节必须按顺序推进', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  consent(svc, id);
  assert.throws(() => svc.prepareHandoff(id, 'transfer'), (e) => e.code === 'STAGE_NOT_CURRENT');
});

test('交接包的 consent_id 指向有效授权', () => {
  const { svc } = clocked();
  const id = seedTrip(svc);
  const cid = consent(svc, id);
  const pkg = handoff(svc, id);
  assert.equal(pkg.consent_id, cid);
});

// ---- 匿名统计 -------------------------------------------------------------

test('统计入口拒收任何身份字段', () => {
  const dash = new AnonymizedDashboard({ k: 2 });
  assert.throws(() => dash.ingest({ ...blockerSignal('visa_consult', 'x'), trip_relay_id: 'trip-1' }), /禁止字段/);
  assert.throws(() => dash.ingest({ domain: 'payment', code: 'x', bucket: '2026-09-20', phone: '1' }), /禁止字段/);
  assert.throws(() => dash.ingest({ domain: 'unknown', code: 'x', bucket: 'b' }), /domain/);
});

test('不足 k 的小群被抑制，无法从结果看到个人旅程', () => {
  const dash = new AnonymizedDashboard({ k: 3 });
  dash.ingest(blockerSignal('payment_setup', 'card_declined', new Date('2026-09-20T10:00:00Z')));
  dash.ingest(blockerSignal('payment_setup', 'card_declined', new Date('2026-09-20T11:00:00Z')));
  for (let i = 0; i < 4; i++) dash.ingest(blockerSignal('visa_consult', 'policy_unclear', new Date('2026-09-20T12:00:00Z')));
  const r = dash.report();
  assert.equal(r.domains.payment.shown, 0);
  assert.equal(r.domains.payment.suppressed, 2);
  assert.equal(r.domains.clearance.shown, 4);
  assert.deepEqual(r.domains.clearance.buckets, [{ bucket: '2026-09-20', code: 'policy_unclear', count: 4 }]);
  // 报告内不含任何旅次级标识。
  assert.ok(!JSON.stringify(r).includes('trip-'));
});

test('堵点只分为通关、支付、接待三类', () => {
  const dash = new AnonymizedDashboard({ k: 1 });
  dash.ingest(blockerSignal('transfer', 'no_accessible_car'));
  dash.ingest(blockerSignal('reception', 'long_wait'));
  const r = dash.report();
  assert.equal(r.domains.reception.total, 2);
  assert.equal(Object.keys(r.domains).length, 3);
});

test('环节目录覆盖五个接力环节', () => {
  assert.deepEqual(STAGES.map((s) => s.id),
    ['visa_consult', 'document_check', 'payment_setup', 'transfer', 'reception']);
  for (const g of Object.values(FIELD_GROUPS)) assert.ok(Array.isArray(g.fields) && g.fields.length > 0);
});
