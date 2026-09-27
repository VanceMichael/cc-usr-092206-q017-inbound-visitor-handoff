// 服务接力核心引擎。
//
// 设计原则：
// 1. 一次旅次一个匿名接力编号，游客的语言偏好、无障碍需求等只采集一次。
// 2. 任何交接都必须有覆盖该资料分组的「明确授权」，且只投影当前环节矩阵要求的分组。
// 3. 行程变动、同行人拆分、服务方替换、付款失败、证件过期都会让后续交接立刻收窄。
// 4. 撤回授权停止所有尚未发生的共享；已发出的资料按分组 TTL 到期抹除。
// 5. 引擎不保存姓名、证件号、手机号等身份字段，数据写入即按目录白名单过滤。

import { randomUUID } from 'node:crypto';
import { STAGES, PROVIDERS, FIELD_GROUPS, buildNeedMatrix } from './catalog.js';

const NEED_MATRIX = buildNeedMatrix();

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

function assert(condition, code, message) {
  if (!condition) throw new RelayError(code, message);
}

// 只保留目录中登记过的分组与字段，任何多余键在入库时就被丢弃。
function projectFields(groupId, source) {
  const spec = FIELD_GROUPS[groupId];
  if (!spec || !source || typeof source !== 'object') return {};
  const out = {};
  for (const field of spec.fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function stageIndex(stageId) {
  return STAGES.findIndex((s) => s.id === stageId);
}

export class RelayService {
  constructor(now = () => new Date()) {
    this._now = now;
    this._trips = new Map();
  }

  _ts() {
    return this._now().toISOString();
  }

  // ---- 旅次与一次性采集 -------------------------------------------------

  createTrip() {
    const trip = {
      tripRelayId: `trip-${randomUUID()}`,
      // 本次旅次的临时匿名联络码，不是手机号或邮箱。
      relayChannelId: `ch-${randomUUID()}`,
      createdAt: this._ts(),
      data: {},
      // 每个分组首次实际交付（共享发生）的时刻，敏感资料 TTL 从此时起算。
      firstDeliveredAt: {},
      consents: [],
      stageState: new Map(STAGES.map((s) => [s.id, { state: 'pending', providerId: s.providerId }])),
      currentStageId: STAGES[0].id,
      packages: [],
      // 收窄标记：付款失败后支付交接只保留重试字段；证件过期后下游不再收到核验结果。
      flags: { paymentRetryOnly: false, documentExpired: false },
      closed: false,
      events: [],
    };
    this._trips.set(trip.tripRelayId, trip);
    this._log(trip, 'trip_created');
    return trip.tripRelayId;
  }

  _trip(id) {
    const trip = this._trips.get(id);
    assert(trip, 'TRIP_NOT_FOUND', '旅次不存在');
    return trip;
  }

  recordGroup(tripId, groupId, raw) {
    const trip = this._trip(tripId);
    assert(!trip.closed, 'TRIP_CLOSED', '旅次已结束');
    assert(FIELD_GROUPS[groupId], 'UNKNOWN_GROUP', `未知资料分组：${groupId}`);
    const clean = projectFields(groupId, raw);
    assert(Object.keys(clean).length > 0, 'EMPTY_RECORD', '没有可登记的目录内字段');
    trip.data[groupId] = { ...(trip.data[groupId] || {}), ...clean };
    this._log(trip, 'group_recorded', { group: groupId });
    return trip.data[groupId];
  }

  // 游客只讲一次的行程需求（语言、无障碍、餐饮）。
  recordTripNeeds(tripId, needs) {
    return this.recordGroup(tripId, 'trip_needs', needs);
  }

  // 签证核验服务方登记核验结论；证件原件与证件号不进入系统。
  recordVerification(tripId, result) {
    const trip = this._trip(tripId);
    const clean = projectFields('doc_verification', result);
    assert(clean.document_status, 'VERIFICATION_INCOMPLETE', '缺少核验结论');
    trip.data.doc_verification = clean;
    // 新核验结论解除过期标记。
    if (clean.document_status === 'valid') trip.flags.documentExpired = false;
    this._log(trip, 'group_recorded', { group: 'doc_verification' });
    return clean;
  }

  // ---- 明确授权 ---------------------------------------------------------

  // 游客必须显式确认，并逐组勾选；没有 explicit 确认一律拒绝。
  grantConsent(tripId, { groups, explicit, statement }) {
    const trip = this._trip(tripId);
    assert(explicit === true, 'CONSENT_NOT_EXPLICIT', '必须取得游客明确同意');
    assert(Array.isArray(groups) && groups.length > 0, 'CONSENT_EMPTY', '授权至少包含一个资料分组');
    for (const g of groups) assert(FIELD_GROUPS[g], 'UNKNOWN_GROUP', `未知资料分组：${g}`);
    const consent = {
      id: `consent-${randomUUID()}`,
      groups: new Set(groups),
      status: 'active',
      grantedAt: this._ts(),
      statement: statement || '游客明确同意按环节交接所选资料',
      revokedGroups: new Set(),
      revokedAt: null,
    };
    trip.consents.push(consent);
    this._log(trip, 'consent_granted', { groups });
    return { consentId: consent.id, groups: [...consent.groups], grantedAt: consent.grantedAt };
  }

  _activeConsentFor(trip, groupId) {
    return trip.consents.find(
      (c) => c.status === 'active' && c.groups.has(groupId) && !c.revokedGroups.has(groupId),
    );
  }

  // 撤回：可整单撤回，也可只撤回某些分组。尚未交付的交接包立即停止共享。
  revokeConsent(tripId, { groups = null } = {}) {
    const trip = this._trip(tripId);
    let affected = 0;
    for (const consent of trip.consents) {
      if (consent.status !== 'active') continue;
      const targets = groups ? groups.filter((g) => consent.groups.has(g)) : [...consent.groups];
      for (const g of targets) consent.revokedGroups.add(g);
      affected += targets.length;
      if (consent.revokedGroups.size >= consent.groups.size) {
        consent.status = 'revoked';
        consent.revokedAt = this._ts();
      }
    }
    assert(affected > 0, 'CONSENT_NOTHING', '没有可撤回的有效授权');

    for (const pkg of trip.packages) {
      if (pkg.deliveredAt || pkg.status === 'revoked' || pkg.status === 'expired') continue;
      const blocked = [...Object.keys(pkg.groups)].some(
        (g) => !this._activeConsentFor(trip, g),
      );
      if (blocked) {
        pkg.status = 'revoked';
        pkg.narrowingReason = 'consent_withdrawn';
        pkg.endedAt = this._ts();
      }
    }
    this._log(trip, 'consent_revoked', { groups });
    return { revokedGroupCount: affected };
  }

  // ---- 环节推进与交接包 -------------------------------------------------

  _currentStage(trip) {
    const state = trip.stageState.get(trip.currentStageId);
    const stage = STAGES.find((s) => s.id === trip.currentStageId);
    return { stage, state };
  }

  // 按当前授权、收窄标记和 TTL，计算某环节此刻真正可以交接的分组。
  _projection(trip, stageId) {
    const { groups: needed } = NEED_MATRIX[stageId];
    const nowMs = this._now().getTime();
    const projected = {};
    const dropped = [];

    for (const groupId of needed) {
      // 授权闸门：没有有效授权的分组直接不进入交接包。
      if (!this._activeConsentFor(trip, groupId)) {
        dropped.push({ group: groupId, reason: 'no_consent' });
        continue;
      }
      // 到期闸门：敏感分组超过 TTL 即视为失效。
      const sharedAt = trip.firstDeliveredAt[groupId];
      const ttl = FIELD_GROUPS[groupId].ttlMs;
      if (sharedAt && ttl && nowMs - new Date(sharedAt).getTime() >= ttl) {
        dropped.push({ group: groupId, reason: 'expired_ttl' });
        continue;
      }
      const raw = groupId === 'relay_contact'
        // 联络码由旅次生成，不需要游客另行登记。
        ? { relay_channel_id: trip.relayChannelId }
        : trip.data[groupId];
      if (!raw) {
        dropped.push({ group: groupId, reason: 'not_collected' });
        continue;
      }

      // 事件收窄：证件过期后，核验结果不再交给下游。
      if (groupId === 'doc_verification' && trip.flags.documentExpired) {
        dropped.push({ group: groupId, reason: 'document_expired' });
        continue;
      }
      if (groupId === 'doc_verification' && raw.valid_until && new Date(raw.valid_until).getTime() <= nowMs) {
        dropped.push({ group: groupId, reason: 'document_expired' });
        continue;
      }
      // 事件收窄：付款失败后，支付交接只保留重试所需两个字段。
      if (groupId === 'payment_help' && trip.flags.paymentRetryOnly) {
        projected[groupId] = {
          help_status: raw.help_status,
          retry_required: true,
        };
        continue;
      }
      projected[groupId] = projectFields(groupId, raw);
    }

    // 接力联系方式始终使用旅次临时联络码。
    if (projected.relay_contact) projected.relay_contact = { relay_channel_id: trip.relayChannelId };
    return { projected, dropped };
  }

  // 生成交接包但尚未共享；交付前仍可被撤回、替换或收窄拦下。
  prepareHandoff(tripId, stageId = null) {
    const trip = this._trip(tripId);
    assert(!trip.closed, 'TRIP_CLOSED', '旅次已结束');
    stageId = stageId || trip.currentStageId;
    assert(stageId === trip.currentStageId, 'STAGE_NOT_CURRENT', '接力按顺序进行，只能交接当前环节');
    const { stage, state } = this._currentStage(trip);
    assert(state.state !== 'done', 'STAGE_DONE', '该环节已完成');

    const { projected, dropped } = this._projection(trip, stageId);
    assert(Object.keys(projected).length > 0, 'NOTHING_TO_HANDOFF', '当前没有可交接的资料（缺少授权或资料已失效）');

    const nowMs = this._now().getTime();
    const expiries = Object.keys(projected)
      .map((g) => FIELD_GROUPS[g].ttlMs)
      .filter((ttl) => ttl)
      .map((ttl) => new Date(nowMs + ttl).toISOString());
    const pkg = {
      packageId: `pkg-${randomUUID()}`,
      tripRelayId: trip.tripRelayId,
      stageId,
      providerId: state.providerId,
      consentId: this._activeConsentFor(trip, Object.keys(projected)[0]).id,
      groups: projected,
      issuedAt: this._ts(),
      expiresAt: expiries.length ? expiries.sort()[0] : null,
      status: 'active',
      narrowingReason: null,
      deliveredAt: null,
      endedAt: null,
      dropped,
    };
    trip.packages.push(pkg);
    state.state = 'handoff_prepared';
    // 收窄状态下重新准备的包也要带上收窄原因，让游客与服务方都能看见。
    if (trip.flags.paymentRetryOnly && projected.payment_help) {
      pkg.status = 'narrowed';
      pkg.narrowingReason = 'payment_failed';
    }
    this._log(trip, 'package_prepared', { stage: stageId, provider: pkg.providerId, groups: Object.keys(projected) });
    return this._publicPackage(pkg);
  }

  // 查询交接包的最新状态（撤回、到期等事件会异步改变状态，不能只凭旧快照判断）。
  getPackage(tripId, packageId) {
    const trip = this._trip(tripId);
    const pkg = trip.packages.find((p) => p.packageId === packageId);
    assert(pkg, 'PACKAGE_NOT_FOUND', '交接包不存在');
    return this._publicPackage(pkg);
  }

  // 真正把交接包交给服务方；已被撤回/失效/作废的包无法交付。
  deliverPackage(tripId, packageId) {
    const trip = this._trip(tripId);
    const pkg = trip.packages.find((p) => p.packageId === packageId);
    assert(pkg, 'PACKAGE_NOT_FOUND', '交接包不存在');
    assert(!pkg.deliveredAt, 'PACKAGE_DELIVERED', '交接包已交付');
    assert(['active', 'narrowed'].includes(pkg.status), 'PACKAGE_BLOCKED', `交接包当前状态为 ${pkg.status}，共享已停止`);

    pkg.deliveredAt = this._ts();
    for (const groupId of Object.keys(pkg.groups)) {
      if (!trip.firstDeliveredAt[groupId]) trip.firstDeliveredAt[groupId] = pkg.deliveredAt;
    }
    this._log(trip, 'package_delivered', { stage: pkg.stageId, provider: pkg.providerId, groups: Object.keys(pkg.groups) });
    return this._publicPackage(pkg);
  }

  completeStage(tripId, { blockers = [] } = {}) {
    const trip = this._trip(tripId);
    const { stage, state } = this._currentStage(trip);
    const delivered = trip.packages.some((p) => p.stageId === stage.id && p.deliveredAt);
    assert(delivered, 'STAGE_NOT_DELIVERED', '交接尚未完成，不能结束环节');
    state.state = 'done';
    state.completedAt = this._ts();

    const idx = stageIndex(stage.id);
    const next = STAGES[idx + 1];
    if (next) {
      trip.currentStageId = next.id;
      trip.stageState.get(next.id).state = 'active';
    } else {
      trip.currentStageId = null;
    }
    this._log(trip, 'stage_completed', { stage: stage.id, blockers });
    return { completed: stage.id, nextStageId: trip.currentStageId, blockers };
  }

  // ---- 收窄事件 ---------------------------------------------------------

  // 1) 行程变动：更新行程数据，尚未交付且受影响的交接包作废，新包按新行程裁剪。
  applyItineraryChange(tripId, { transportPatch, receptionPatch, dropGroups = [] } = {}) {
    const trip = this._trip(tripId);
    if (transportPatch) {
      trip.data.transport_arrangement = {
        ...(trip.data.transport_arrangement || {}),
        ...projectFields('transport_arrangement', transportPatch),
      };
    }
    if (receptionPatch) {
      trip.data.reception_confirmation = {
        ...(trip.data.reception_confirmation || {}),
        ...projectFields('reception_confirmation', receptionPatch),
      };
    }
    for (const g of dropGroups) delete trip.data[g];

    const affectedGroups = new Set([
      ...(transportPatch ? ['transport_arrangement'] : []),
      ...(receptionPatch ? ['reception_confirmation'] : []),
      ...dropGroups,
    ]);
    this._voidUndelivered(trip, (pkg) => {
      const hit = [...affectedGroups].some((g) => pkg.groups[g]);
      return hit ? { status: 'superseded', reason: 'itinerary_changed' } : null;
    });
    this._log(trip, 'itinerary_changed', { groups: [...affectedGroups] });
    return { appliedGroups: [...affectedGroups] };
  }

  // 2) 同行人拆分：座位/人数立即下调，沿用旧人数的未交付包作废重发。
  splitParty(tripId, { seatsRemove = 0, partySizeRemove = 0 } = {}) {
    const trip = this._trip(tripId);
    const t = trip.data.transport_arrangement;
    const r = trip.data.reception_confirmation;
    if (t && seatsRemove > 0) t.seats = Math.max(1, (t.seats || 1) - seatsRemove);
    if (r && partySizeRemove > 0) r.party_size = Math.max(1, (r.party_size || 1) - partySizeRemove);

    this._voidUndelivered(trip, (pkg) =>
      pkg.groups.transport_arrangement || pkg.groups.reception_confirmation
        ? { status: 'superseded', reason: 'party_split' }
        : null,
    );
    this._log(trip, 'party_split', { seatsRemove, partySizeRemove });
    return { seats: t?.seats ?? null, partySize: r?.party_size ?? null };
  }

  // 3) 服务方替换：未交给旧服务方的包立刻撤回；已交付的只保留到 TTL 到期。
  replaceProvider(tripId, stageId, newProviderId) {
    const trip = this._trip(tripId);
    assert(PROVIDERS[newProviderId], 'UNKNOWN_PROVIDER', '新服务方未登记');
    const state = trip.stageState.get(stageId);
    assert(state, 'UNKNOWN_STAGE', '环节不存在');
    assert(state.state !== 'done', 'STAGE_DONE', '已完成环节不能替换服务方');
    const oldProviderId = state.providerId;
    state.providerId = newProviderId;

    for (const pkg of trip.packages) {
      if (pkg.stageId !== stageId || pkg.deliveredAt) continue;
      if (pkg.providerId === oldProviderId && ['active', 'narrowed'].includes(pkg.status)) {
        pkg.status = 'revoked';
        pkg.narrowingReason = 'provider_replaced';
        pkg.endedAt = this._ts();
      }
    }
    if (state.state === 'handoff_prepared') state.state = 'active';
    this._log(trip, 'provider_replaced', { stage: stageId, old: oldProviderId, next: newProviderId });
    return { stageId, oldProviderId, newProviderId };
  }

  // 4) 付款失败：支付交接收窄为重试信号，下一联系人回到支付服务方。
  paymentFailed(tripId) {
    const trip = this._trip(tripId);
    trip.flags.paymentRetryOnly = true;
    if (trip.data.payment_help) {
      trip.data.payment_help.help_status = 'failed';
      trip.data.payment_help.retry_required = true;
    }
    for (const pkg of trip.packages) {
      if (pkg.deliveredAt || !pkg.groups.payment_help) continue;
      // 支付环节自身的包保留，但只剩重试字段；其他环节若误带支付帮助则移除该组。
      if (pkg.stageId === 'payment_setup') {
        pkg.groups.payment_help = { help_status: 'failed', retry_required: true };
        pkg.status = 'narrowed';
        pkg.narrowingReason = 'payment_failed';
      } else {
        delete pkg.groups.payment_help;
        pkg.status = Object.keys(pkg.groups).length ? 'narrowed' : 'superseded';
        pkg.narrowingReason = 'payment_failed';
      }
      pkg.endedAt = this._ts();
    }
    this._log(trip, 'payment_failed');
    return { retryRequired: true };
  }

  // 付款重试成功：解除支付收窄，后续交接恢复完整支付帮助字段。
  paymentRecovered(tripId) {
    const trip = this._trip(tripId);
    trip.flags.paymentRetryOnly = false;
    if (trip.data.payment_help) {
      trip.data.payment_help.help_status = 'active';
      trip.data.payment_help.retry_required = false;
    }
    this._log(trip, 'payment_recovered');
    return { retryRequired: false };
  }

  // 5) 证件过期：下游交接一律移除核验结果，游客需重新核验后才能继续。
  documentExpired(tripId) {
    const trip = this._trip(tripId);
    trip.flags.documentExpired = true;
    if (trip.data.doc_verification) trip.data.doc_verification.document_status = 'expired';
    this._voidUndelivered(trip, (pkg) => {
      if (!pkg.groups.doc_verification) return null;
      delete pkg.groups.doc_verification;
      return Object.keys(pkg.groups).length
        ? { status: 'narrowed', reason: 'document_expired' }
        : { status: 'superseded', reason: 'document_expired' };
    });
    this._log(trip, 'document_expired');
    return { reverificationRequired: true };
  }

  _voidUndelivered(trip, decide) {
    for (const pkg of trip.packages) {
      if (pkg.deliveredAt || ['revoked', 'expired', 'superseded'].includes(pkg.status)) continue;
      const verdict = decide(pkg);
      if (verdict) {
        pkg.status = verdict.status;
        pkg.narrowingReason = verdict.reason;
        pkg.endedAt = this._ts();
      }
    }
  }

  // ---- 到期失效 ---------------------------------------------------------

  // 扫过所有旅次：到 TTL 的敏感分组被抹除，证件到期自动转过期收窄。
  sweep() {
    const now = this._now();
    const nowMs = now.getTime();
    const report = { erased: [], expiredPackages: [], documentsExpired: [] };
    for (const trip of this._trips.values()) {
      for (const [groupId, sharedAt] of Object.entries(trip.firstDeliveredAt)) {
        const ttl = FIELD_GROUPS[groupId].ttlMs;
        if (ttl && nowMs - new Date(sharedAt).getTime() >= ttl && trip.data[groupId]) {
          delete trip.data[groupId];
          report.erased.push({ tripRelayId: trip.tripRelayId, group: groupId });
          // 整包 expires_at 取最早分组到期时刻：含该分组的包（无论是否已交付）到期，
          // 其余长 TTL 分组如需继续使用，由后续环节重新生成交接包。
          for (const pkg of trip.packages) {
            if (pkg.groups[groupId] && pkg.status !== 'expired') {
              delete pkg.groups[groupId];
              pkg.status = 'expired';
              pkg.endedAt = now.toISOString();
              if (!pkg.deliveredAt) report.expiredPackages.push(pkg.packageId);
            }
          }
        }
      }
      const doc = trip.data.doc_verification;
      if (doc && !trip.flags.documentExpired && doc.valid_until && new Date(doc.valid_until).getTime() <= nowMs) {
        trip.flags.documentExpired = true;
        doc.document_status = 'expired';
        report.documentsExpired.push(trip.tripRelayId);
      }
      if (trip.closed) continue;
    }
    return report;
  }

  closeTrip(tripId) {
    const trip = this._trip(tripId);
    trip.closed = true;
    // 旅次结束即抹除全部采集内容，只留下不含明细的事件审计痕迹。
    trip.data = {};
    trip.firstDeliveredAt = {};
    this._log(trip, 'trip_closed');
    return { tripRelayId: trip.tripRelayId, closed: true };
  }

  // ---- 游客视角的接力卡：下一联系人 + 待办动作 ---------------------------

  relayCard(tripId) {
    const trip = this._trip(tripId);
    const todos = [];
    const alerts = [];
    let nextContact = null;

    // 收窄事件优先决定「下一个该联系谁」。
    if (trip.flags.documentExpired) {
      const p = PROVIDERS['visa-service'];
      nextContact = { providerId: p.id, name: p.name, reason: '证件已过期，需重新核验' };
      todos.push('联系签证核验服务方完成旅行文件重新核验');
      alerts.push('原核验结果已失效，通关与接待环节暂停使用该结果');
    } else if (trip.flags.paymentRetryOnly && trip.stageState.get('payment_setup').state !== 'done') {
      const p = PROVIDERS['payment-provider'];
      nextContact = { providerId: p.id, name: p.name, reason: '付款失败，需要重试' };
      todos.push('在移动支付服务方完成付款重试或更换支付渠道');
    }

    if (!nextContact && trip.currentStageId) {
      const cur = STAGES.find((s) => s.id === trip.currentStageId);
      const state = trip.stageState.get(trip.currentStageId);
      const provider = PROVIDERS[state.providerId];
      nextContact = {
        providerId: provider.id,
        name: provider.name,
        viaChannelId: trip.relayChannelId,
        reason: cur.purpose,
      };
      todos.push(this._todoFor(cur.id, trip));
    }

    if (!trip.currentStageId && !trip.flags.documentExpired) {
      todos.push('全部环节已完成，无需进一步动作');
    }

    const shared = trip.packages
      .filter((p) => p.deliveredAt)
      .map((p) => ({
        stage: STAGES.find((s) => s.id === p.stageId).name,
        provider: PROVIDERS[p.providerId].name,
        groups: Object.keys(p.groups).map((g) => FIELD_GROUPS[g].name),
        deliveredAt: p.deliveredAt,
        expiresAt: p.expiresAt,
        status: p.status,
      }));

    const pending = trip.packages
      .filter((p) => !p.deliveredAt && ['active', 'narrowed'].includes(p.status))
      .map((p) => ({
        packageId: p.packageId,
        stage: STAGES.find((s) => s.id === p.stageId).name,
        provider: PROVIDERS[p.providerId].name,
        groups: Object.keys(p.groups).map((g) => FIELD_GROUPS[g].name),
        status: p.status,
      }));

    return {
      tripRelayId: trip.tripRelayId,
      currentStage: trip.currentStageId ? STAGES.find((s) => s.id === trip.currentStageId).name : null,
      nextContact,
      todos,
      alerts,
      sharedHistory: shared,
      pendingHandoffs: pending,
    };
  }

  _todoFor(stageId, trip) {
    switch (stageId) {
      case 'visa_consult':
        return '向境外页面旅行服务商确认签证与入境政策（行程需求仅需讲述一次）';
      case 'document_check':
        return '等待签证核验服务方出具核验结果';
      case 'payment_setup':
        return trip.flags.paymentRetryOnly
          ? '在移动支付服务方完成付款重试'
          : '通过临时联络码接受移动支付绑定帮助';
      case 'transfer':
        return '按交通服务方安排抵达景区换乘点，无需重复说明语言与无障碍需求';
      case 'reception':
        return '在景区接待方确认入园，语言与无障碍安排已随接力送达';
      default:
        return '等待下一环节';
    }
  }

  // 审计事件只记录类型、环节与分组名，不记录字段值。
  _log(trip, type, detail = {}) {
    trip.events.push({ type, at: this._ts(), ...detail });
  }

  _publicPackage(pkg) {
    return {
      package_id: pkg.packageId,
      trip_relay_id: pkg.tripRelayId,
      stage_id: pkg.stageId,
      provider_id: pkg.providerId,
      consent_id: pkg.consentId,
      groups: pkg.groups,
      issued_at: pkg.issuedAt,
      expires_at: pkg.expiresAt,
      status: pkg.status === 'active' && pkg.narrowingReason ? 'narrowed' : pkg.status,
      dropped: pkg.dropped ?? [],
      ...(pkg.narrowingReason ? { narrowing_reason: pkg.narrowingReason } : {}),
      ...(pkg.deliveredAt ? { delivered_at: pkg.deliveredAt } : {}),
    };
  }
}
