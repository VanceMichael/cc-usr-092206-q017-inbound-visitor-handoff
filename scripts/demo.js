// 端到端演示：一位入境游客的一次旅次服务接力。
// 运行：node scripts/demo.js

import { RelayService, RelayError } from '../src/relay.js';
import { AnonymizedDashboard, blockerSignal } from '../src/analytics.js';
import { FIELD_GROUPS } from '../src/catalog.js';

const DAY = 24 * 60 * 60 * 1000;
let clock = new Date('2026-09-20T08:00:00Z');
const advance = (ms) => { clock = new Date(clock.getTime() + ms); };

const relay = new RelayService(() => clock);
const dash = new AnonymizedDashboard({ k: 3 });

function heading(t) {
  console.log(`\n=== ${t} ===`);
}
function showCard(relay, tripId) {
  const card = relay.relayCard(tripId);
  console.log(`当前环节：${card.currentStage ?? '—'} ｜ 下一联系人：${card.nextContact?.name ?? '无'}`);
  if (card.nextContact?.reason) console.log(`  原因：${card.nextContact.reason}`);
  for (const todo of card.todos) console.log(`  待办：${todo}`);
  for (const a of card.alerts) console.log(`  提醒：${a}`);
  return card;
}
function showPkg(pkg) {
  const groups = Object.entries(pkg.groups)
    .map(([g, v]) => `${FIELD_GROUPS[g].name}[${Object.keys(v).join('/')}]`)
    .join('，');
  console.log(`  交接包 → ${pkg.provider_id}：${groups || '（空）'} [${pkg.status}] 到期：${pkg.expires_at ?? '—'}`);
  for (const d of pkg.dropped ?? []) console.log(`    未包含：${FIELD_GROUPS[d.group].name}（${d.reason}）`);
}

// 1. 建旅次：游客的语言偏好与无障碍需求只讲一次。
heading('建立旅次与一次性采集');
const tripId = relay.createTrip();
relay.recordTripNeeds(tripId, {
  languages: ['英语', '基础日语'],
  accessibility: '需要轮椅坡道',
  dietary_notes: '素食',
  passport_number: 'SHOULD-NEVER-ENTER', // 白名单外字段，入库即丢弃
});
relay.recordVerification(tripId, {
  document_status: 'valid',
  visa_type: 'L',
  valid_until: '2026-09-22T12:00:00Z',
  verification_ref: 'vr-7788',
});
relay.recordGroup(tripId, 'payment_help', { preferred_channels: ['国际信用卡', '电子钱包'], help_status: 'pending' });
relay.recordGroup(tripId, 'transport_arrangement', {
  route: '机场 → 景区换乘点',
  scheduled_at: '2026-09-22T10:00:00Z',
  seats: 4,
  accessible_vehicle: true,
});
relay.recordGroup(tripId, 'reception_confirmation', {
  site: '云湖景区',
  booking_ref: 'BK-2099',
  scheduled_at: '2026-09-22T11:00:00Z',
  party_size: 4,
});
console.log('已登记：行程需求、文件核验结论（无证件号）、支付帮助、交通、接待');

// 2. 明确授权：游客逐组勾选。
heading('游客明确同意（逐组授权）');
try {
  relay.prepareHandoff(tripId);
} catch (e) {
  if (e instanceof RelayError) console.log(`未授权先交接被拒：${e.code}`);
}
const consent = relay.grantConsent(tripId, {
  groups: ['trip_needs', 'doc_verification', 'payment_help', 'transport_arrangement', 'reception_confirmation', 'relay_contact'],
  explicit: true,
  statement: '我同意按一次旅次把完成各环节所需资料交给对应服务方',
});
console.log(`授权成立：${consent.consentId}`);

// 3. 接力：境外咨询 → 文件核验 → 支付帮助（交付后、环节结束前付款失败）。
heading('环节接力（每环只拿最小必要资料）');
let pkg = relay.prepareHandoff(tripId);
showPkg(pkg);
relay.deliverPackage(tripId, pkg.package_id);
relay.completeStage(tripId, { blockers: [] });

pkg = relay.prepareHandoff(tripId);
showPkg(pkg);
relay.deliverPackage(tripId, pkg.package_id);
relay.completeStage(tripId, { blockers: [] });

pkg = relay.prepareHandoff(tripId);
showPkg(pkg);
relay.deliverPackage(tripId, pkg.package_id);
showCard(relay, tripId);

// 4. 付款失败：交接收窄为重试信号，下一联系人回到支付服务方。
heading('事件：付款失败 → 交接收窄');
relay.paymentFailed(tripId);
dash.ingest(blockerSignal('payment_setup', 'card_declined', clock));
console.log('支付帮助只剩 help_status/retry_required；下一联系人回到支付服务方');
showCard(relay, tripId);
advance(30 * 60 * 1000);
relay.paymentRecovered(tripId);
console.log('付款重试成功，支付环节结束，继续接力');
relay.completeStage(tripId, { blockers: [] });

// 5. 同行人拆分：座位与人数下调，旧包作废重发。
heading('事件：同行人拆分');
relay.splitParty(tripId, { seatsRemove: 2, partySizeRemove: 2 });

// 6. 行程变动：换乘时间提前。
heading('事件：行程变动');
relay.applyItineraryChange(tripId, {
  transportPatch: { scheduled_at: '2026-09-22T09:30:00Z' },
});

// 7. 服务方替换：接待方换成备用方，旧包撤回。
heading('事件：接待服务方替换');
relay.replaceProvider(tripId, 'reception', 'scenic-reception-b');

// 8. 交通交接：无需重述语言与无障碍需求。
heading('景区换乘交接（游客不再重复填表）');
pkg = relay.prepareHandoff(tripId);
showPkg(pkg);
relay.deliverPackage(tripId, pkg.package_id);
relay.completeStage(tripId, { blockers: [] });

// 9. 证件过期：接待环节的核验结果被移除。
heading('事件：证件过期 → 下游交接移除核验结果');
advance(10 * DAY); // 越过 valid_until
relay.sweep();
pkg = relay.prepareHandoff(tripId);
showPkg(pkg);
for (const d of pkg.dropped ?? []) console.log(`  核验结果未交给接待方：${d.reason}`);
dash.ingest(blockerSignal('document_check', 'visa_expired_at_gate', clock));

// 10. 游客撤回：尚未发生的共享立即停止。
heading('游客撤回授权');
relay.revokeConsent(tripId);
try {
  relay.prepareHandoff(tripId);
} catch (e) {
  if (e instanceof RelayError) console.log(`撤回后的新交接被拒：${e.code}`);
}

// 11. 到期失效：敏感资料到 TTL 抹除。
heading('敏感资料到期失效');
advance(31 * DAY);
const sweep = relay.sweep();
console.log(`抹除分组 ${sweep.erased.length} 项：${sweep.erased.map((e) => e.group).join('、') || '无'}`);
relay.closeTrip(tripId);

// 12. 行业管理视角：只有匿名聚合，小群被抑制。
heading('行业管理人员视图（仅匿名堵点聚合）');
// 补足通关堵点样本以越过 k=3，模拟来自不同旅次的匿名信号。
for (let i = 0; i < 3; i++) dash.ingest(blockerSignal('visa_consult', 'policy_unclear', clock));
try {
  dash.ingest({ ...blockerSignal('reception', 'long_wait', clock), trip_relay_id: tripId });
} catch (e) {
  console.log(`携带旅次编号的统计行被拒收：${e.message}`);
}
const report = dash.report();
for (const [id, d] of Object.entries(report.domains)) {
  if (d.total === 0) continue;
  console.log(`${d.domain_name}：总数 ${d.total}，展示 ${d.shown}，小群抑制 ${d.suppressed}`);
  for (const b of d.buckets) console.log(`  ${b.bucket} ${b.code} × ${b.count}`);
}
