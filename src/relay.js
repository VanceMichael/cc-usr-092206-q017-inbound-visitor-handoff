import { randomUUID } from 'node:crypto';
import {
  LEGS,
  LEG_LABELS,
  LEG_CATEGORIES,
  buildPacket,
  packetSignature,
  outdatedFields,
  findLegItem,
  legBlocker,
} from './packets.js';

// 一次旅次 = 一条服务接力链。旅次内不保存姓名、证件号等身份资料，
// 只保存完成服务所需的偏好与核验结论。
export function createTrip({ traveler, itinerary, companions = [], now = 0, salt = 'relay-v1' }) {
  if (!traveler?.language) throw new Error('旅次需要游客的语言偏好');
  if (!Array.isArray(itinerary) || itinerary.length === 0) throw new Error('旅次需要至少一个环节');
  for (const item of itinerary) {
    if (!LEGS.includes(item.leg)) throw new Error(`未知环节: ${item.leg}`);
    if (!item.providerId) throw new Error(`环节 ${item.leg} 缺少服务商`);
  }
  return {
    id: randomUUID(),
    salt,
    createdAt: now,
    traveler: {
      language: traveler.language,
      accessibilityNeeds: traveler.accessibilityNeeds ?? [],
    },
    companions: companions.map((c) => ({ id: c.id ?? randomUUID(), needs: c.needs ?? {} })),
    itinerary: itinerary.map((item) => ({ status: 'pending', ...item })),
    documents: { verification: null },
    payment: { status: 'not_started', method: null, failureReason: null },
    consent: { status: 'none', scope: [], noticeVersion: null, grantedAt: null, revokedAt: null },
    handoffs: [],
    notices: [],
    audit: [],
  };
}

function log(trip, type, detail, now) {
  trip.audit.push({ at: now, type, detail });
}

// 明确同意：记录告知版本与授权范围，任何共享都发生在同意之后。
export function grantConsent(trip, { scope = LEGS, noticeVersion, now = 0 } = {}) {
  if (!noticeVersion) throw new Error('明确同意需要记录告知版本');
  const invalid = scope.filter((leg) => !LEGS.includes(leg));
  if (invalid.length > 0) throw new Error(`授权范围包含未知环节: ${invalid.join(',')}`);
  trip.consent = { status: 'granted', scope: [...scope], noticeVersion, grantedAt: now, revokedAt: null };
  log(trip, 'consent_granted', { scope: [...scope] }, now);
  return trip.consent;
}

// 撤回授权：停止尚未发生的共享；已送达的记录保留在审计中，但不再发出新的交接。
export function revokeConsent(trip, { now = 0 } = {}) {
  if (trip.consent.status !== 'granted') return;
  trip.consent.status = 'revoked';
  trip.consent.revokedAt = now;
  log(trip, 'consent_revoked', {}, now);
}

export function completeLeg(trip, leg, { now = 0 } = {}) {
  const item = findLegItem(trip, leg);
  if (!item) throw new Error(`旅次中没有环节: ${leg}`);
  item.status = 'completed';
  log(trip, 'leg_completed', { leg }, now);
}

// 已送达交接的收窄：行程或状态变化后，重建交接内容；
// 变窄则通知服务商丢弃过时字段，环节或服务商不再匹配则撤回。
function refreshDispatched(trip, now) {
  for (const handoff of trip.handoffs) {
    if (handoff.status !== 'dispatched') continue;
    const item = findLegItem(trip, handoff.leg);
    if (!item || item.providerId !== handoff.providerId) {
      handoff.status = 'withdrawn';
      trip.notices.push({ type: 'withdraw', provider_id: handoff.providerId, handoff_id: handoff.id, at: now });
      log(trip, 'handoff_withdrawn', { leg: handoff.leg, provider: handoff.providerId }, now);
      continue;
    }
    const packet = buildPacket(trip, handoff.leg, now);
    packet.handoff_id = handoff.id;
    // 收窄不延长存续期：到期时间仍以首次送达为准。
    packet.issued_at = handoff.packet.issued_at;
    packet.expires_at = handoff.packet.expires_at;
    const signature = packetSignature(packet);
    if (signature !== handoff.signature) {
      const discard = outdatedFields(handoff.packet.categories, packet.categories);
      handoff.packet = packet;
      handoff.signature = signature;
      handoff.revisions = (handoff.revisions ?? 0) + 1;
      trip.notices.push({ type: 'narrow', provider_id: handoff.providerId, handoff_id: handoff.id, discard, at: now });
      log(trip, 'handoff_narrowed', { leg: handoff.leg, discard }, now);
    }
  }
}

// 敏感资料到期失效：核验结论过期即不可再共享，交接包到期即作废。
export function purgeExpired(trip, { now = 0 } = {}) {
  const verification = trip.documents.verification;
  if (verification && verification.status === 'valid' && verification.expiresAt != null && verification.expiresAt <= now) {
    verification.status = 'expired';
    log(trip, 'document_expired', { leg: 'entry', cause: 'ttl' }, now);
    refreshDispatched(trip, now);
  }
  for (const handoff of trip.handoffs) {
    if (handoff.status === 'dispatched' && handoff.packet.expires_at <= now) {
      handoff.status = 'expired';
      trip.notices.push({ type: 'expire', provider_id: handoff.providerId, handoff_id: handoff.id, at: now });
      log(trip, 'handoff_expired', { leg: handoff.leg }, now);
    }
  }
}

// 调度：仅当同意有效、环节在授权范围内且前置条件满足时，
// 才把当前环节所需的交接包交给对应服务商。
export function syncHandoffs(trip, { now = 0 } = {}) {
  purgeExpired(trip, { now });
  const result = { dispatched: [], withheld: [] };
  if (trip.consent.status !== 'granted') return result;
  const current = trip.itinerary.find((item) => item.status === 'pending');
  if (!current) return result;
  if (!trip.consent.scope.includes(current.leg)) {
    result.withheld.push({ leg: current.leg, reason: 'consent_missing' });
    return result;
  }
  const blocker = legBlocker(trip, current.leg);
  if (blocker) {
    result.withheld.push({ leg: current.leg, reason: blocker });
    return result;
  }
  const active = trip.handoffs.find((h) => h.leg === current.leg && h.status === 'dispatched');
  if (active) return result;
  const packet = buildPacket(trip, current.leg, now);
  trip.handoffs.push({
    id: packet.handoff_id,
    leg: current.leg,
    providerId: packet.provider_id,
    signature: packetSignature(packet),
    packet,
    status: 'dispatched',
    dispatchedAt: now,
  });
  log(trip, 'handoff_dispatched', { leg: current.leg, provider: packet.provider_id, categories: Object.keys(packet.categories) }, now);
  result.dispatched.push(packet);
  return result;
}

// 行程变动：保留未变更环节的进度，已送达给不再需要的服务商的交接被撤回。
export function changeItinerary(trip, nextItinerary, { now = 0 } = {}) {
  const previous = trip.itinerary;
  trip.itinerary = nextItinerary.map((item) => {
    const kept = previous.find((p) => p.leg === item.leg);
    return { status: kept?.status ?? 'pending', ...item };
  });
  log(trip, 'itinerary_changed', { legs: trip.itinerary.map((i) => i.leg) }, now);
  refreshDispatched(trip, now);
}

// 同行人拆分：后续交接只按剩余人数准备，已送达的收到收窄通知。
export function splitCompanions(trip, companionIds, { now = 0 } = {}) {
  const leaving = new Set(companionIds);
  trip.companions = trip.companions.filter((c) => !leaving.has(c.id));
  log(trip, 'companions_split', { remaining: trip.companions.length }, now);
  refreshDispatched(trip, now);
}

// 服务方替换：旧服务商收到撤回通知，新服务商只拿到完成当前环节所需的内容。
export function replaceProvider(trip, leg, newProviderId, { now = 0 } = {}) {
  const item = findLegItem(trip, leg);
  if (!item) throw new Error(`旅次中没有环节: ${leg}`);
  const previous = item.providerId;
  item.providerId = newProviderId;
  log(trip, 'provider_replaced', { leg, previous, next: newProviderId }, now);
  refreshDispatched(trip, now);
}

export function recordPaymentOutcome(trip, { status, method, reason, now = 0 } = {}) {
  trip.payment = {
    status,
    method: method ?? trip.payment.method,
    failureReason: status === 'failed' ? reason ?? 'unknown' : null,
  };
  if (status === 'failed') {
    // 付款失败：支付环节重新打开，依赖支付结果的交接随之收窄。
    const item = findLegItem(trip, 'payment');
    if (item && item.status === 'completed') item.status = 'pending';
    log(trip, 'payment_failed', { leg: 'payment' }, now);
  } else {
    log(trip, `payment_${status}`, { leg: 'payment' }, now);
  }
  refreshDispatched(trip, now);
}

export function recordDocumentVerification(trip, { documentType, validUntil, expiresAt, now = 0 } = {}) {
  trip.documents.verification = { status: 'valid', documentType, validUntil, expiresAt };
  log(trip, 'document_verified', { leg: 'entry' }, now);
}

// 证件过期：核验结论失效，通关交接暂扣，已送达的收窄为不含核验结果。
export function recordDocumentExpiry(trip, { now = 0 } = {}) {
  if (trip.documents.verification) trip.documents.verification.status = 'expired';
  log(trip, 'document_expired', { leg: 'entry' }, now);
  refreshDispatched(trip, now);
}

// 游客视图：下一联系人、待办动作、即将共享给服务商的内容。
export function touristView(trip, { now = 0 } = {}) {
  purgeExpired(trip, { now });
  const actions = [];
  if (trip.consent.status !== 'granted') {
    actions.push({ code: 'grant_consent', label: '确认服务接力授权后，下一环节的服务商才能收到必要资料' });
  }
  const current = trip.itinerary.find((item) => item.status === 'pending') ?? null;
  if (current && legBlocker(trip, current.leg) === 'document_check_missing') {
    actions.push({ code: 'refresh_document_check', label: '旅行文件核验已失效，请重新完成核验' });
  }
  if (trip.payment.status === 'failed') {
    actions.push({ code: 'retry_payment', label: '支付未成功，请重试或更换支付方式' });
  }
  return {
    next_contact: current
      ? {
          leg: current.leg,
          label: LEG_LABELS[current.leg],
          provider_id: current.providerId,
          meeting_point: current.location ?? null,
          scheduled_at: current.scheduledAt ?? null,
        }
      : null,
    pending_actions: actions,
    upcoming_share:
      current && trip.consent.status === 'granted'
        ? { leg: current.leg, provider_id: current.providerId, categories: LEG_CATEGORIES[current.leg] }
        : null,
    consent_status: trip.consent.status,
  };
}
