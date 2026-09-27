import { createHash, randomUUID } from 'node:crypto';

// 旅次环节：通关、支付、交通、接待。
export const LEGS = ['entry', 'payment', 'transport', 'reception'];

export const LEG_LABELS = {
  entry: '通关与签证协助',
  payment: '移动支付协助',
  transport: '交通换乘安排',
  reception: '景区接待确认',
};

// 可交接资料类别：行程需求、旅行文件核验结果、支付帮助、交通安排、接待确认。
export const CATEGORIES = [
  'itinerary_needs',
  'document_check',
  'payment_help',
  'transport_plan',
  'reception_confirmation',
];

// 最小必要：每个环节的服务商只领取完成该环节所需的类别。
export const LEG_CATEGORIES = {
  entry: ['itinerary_needs', 'document_check'],
  payment: ['itinerary_needs', 'payment_help'],
  transport: ['itinerary_needs', 'transport_plan'],
  reception: ['itinerary_needs', 'reception_confirmation'],
};

// 交接包本身的存续期：到期后服务商不得再继续使用。
export const PACKET_TTL_MS = 24 * 60 * 60 * 1000;

// 面向服务商的假名引用：同一游客对不同服务商呈现不同标识，避免跨环节串联个人旅程。
export function pseudonym(...parts) {
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, 16);
}

export function findLegItem(trip, leg) {
  return trip.itinerary.find((item) => item.leg === leg) ?? null;
}

// 各类别只从旅次状态中提取该环节所需的最小字段。
const CATEGORY_BUILDERS = {
  itinerary_needs(trip, leg) {
    const item = findLegItem(trip, leg);
    return {
      language: trip.traveler.language,
      accessibility: trip.traveler.accessibilityNeeds,
      party_size: 1 + trip.companions.length,
      scheduled_at: item?.scheduledAt ?? null,
      meeting_point: item?.location ?? null,
    };
  },
  document_check(trip) {
    const verification = trip.documents.verification;
    if (!verification || verification.status !== 'valid') return null;
    // 只交接核验结论，不交接证件本身。
    return {
      status: 'valid',
      document_type: verification.documentType,
      valid_until: verification.validUntil,
    };
  },
  payment_help(trip) {
    const help = { status: trip.payment.status, method: trip.payment.method };
    if (trip.payment.status === 'failed') {
      help.failure_reason = trip.payment.failureReason ?? 'unknown';
    }
    return help;
  },
  transport_plan(trip) {
    const details = findLegItem(trip, 'transport')?.details ?? {};
    return {
      from: details.from ?? null,
      to: details.to ?? null,
      mode: details.mode ?? null,
    };
  },
  reception_confirmation(trip) {
    const item = findLegItem(trip, 'reception');
    return {
      site: item?.details?.site ?? item?.location ?? null,
      reservation_ref: pseudonym(trip.salt, trip.id, 'reception'),
      payment_confirmed: trip.payment.status === 'confirmed',
    };
  },
};

// 环节前置条件：不满足时交接暂扣，转为游客待办。
export function legBlocker(trip, leg) {
  if (leg === 'entry') {
    const verification = trip.documents.verification;
    if (!verification || verification.status !== 'valid') return 'document_check_missing';
  }
  return null;
}

export function buildPacket(trip, leg, now) {
  const item = findLegItem(trip, leg);
  if (!item) return null;
  const categories = {};
  for (const category of LEG_CATEGORIES[leg]) {
    const value = CATEGORY_BUILDERS[category](trip, leg);
    if (value != null) categories[category] = value;
  }
  return {
    handoff_id: randomUUID(),
    subject_ref: pseudonym(trip.salt, trip.id, item.providerId),
    leg,
    provider_id: item.providerId,
    categories,
    issued_at: now,
    expires_at: now + PACKET_TTL_MS,
  };
}

// 内容签名用于判断交接内容是否因行程或状态变化而收窄。
export function packetSignature(packet) {
  return createHash('sha256')
    .update(JSON.stringify([packet.leg, packet.provider_id, packet.categories]))
    .digest('hex');
}

// 计算服务商应当丢弃或刷新的字段路径（被移除或被改窄的字段）。
export function outdatedFields(oldCategories, newCategories, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(oldCategories)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in newCategories)) {
      paths.push(path);
      continue;
    }
    const next = newCategories[key];
    if (value && next && typeof value === 'object' && typeof next === 'object') {
      paths.push(...outdatedFields(value, next, path));
    } else if (JSON.stringify(value) !== JSON.stringify(next)) {
      paths.push(path);
    }
  }
  return paths;
}
