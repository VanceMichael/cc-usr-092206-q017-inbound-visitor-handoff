// 服务接力目录：环节顺序、服务方登记、最小必要资料分组与授权口径。
// 这里只放静态目录事实，不含任何真实个人信息。

// 一次旅次按时间顺序经过的环节。
export const STAGES = [
  {
    id: 'visa_consult',
    name: '境外签证咨询',
    providerId: 'ota-overseas',
    purpose: '在境外页面回答签证与入境政策咨询',
    // 完成本环节所需的最小资料分组，见 NEED_MATRIX。
    needs: ['trip_needs'],
  },
  {
    id: 'document_check',
    name: '旅行文件核验',
    providerId: 'visa-service',
    purpose: '核验签证等旅行文件并出具核验结果',
    // 核验结果由本环节产生，供后续环节引用；本环节只需要行程需求。
    needs: ['trip_needs'],
  },
  {
    id: 'payment_setup',
    name: '落地移动支付帮助',
    providerId: 'payment-provider',
    purpose: '帮助游客绑定并使用移动支付',
    needs: ['trip_needs', 'payment_help', 'relay_contact'],
  },
  {
    id: 'transfer',
    name: '景区换乘交通',
    providerId: 'transport-provider',
    purpose: '安排前往景区的换乘交通与无障碍车辆',
    needs: ['trip_needs', 'transport_arrangement', 'doc_verification', 'relay_contact'],
  },
  {
    id: 'reception',
    name: '景区接待确认',
    providerId: 'scenic-reception',
    purpose: '确认入园接待、语言与无障碍安排',
    needs: ['trip_needs', 'reception_confirmation', 'doc_verification', 'relay_contact'],
  },
];

// 服务方登记。id 对外可见，但交接包通过逐次交接码引用，不附带游客真实身份。
export const PROVIDERS = {
  'ota-overseas': { id: 'ota-overseas', name: '境外页面旅行服务商', role: 'travel' },
  'visa-service': { id: 'visa-service', name: '签证核验服务方', role: 'document' },
  'payment-provider': { id: 'payment-provider', name: '移动支付服务方', role: 'payment' },
  'transport-provider': { id: 'transport-provider', name: '景区交通服务方', role: 'transport' },
  'scenic-reception': { id: 'scenic-reception', name: '景区接待方', role: 'reception' },
  'scenic-reception-b': { id: 'scenic-reception-b', name: '备用景区接待方', role: 'reception' },
};

// 可交接的资料分组。每一组是授权与最小必要裁剪的最小单位：
// 游客按组授权，服务方按环节只拿到矩阵列出的组。
export const FIELD_GROUPS = {
  trip_needs: {
    name: '行程需求',
    // 游客只需讲一次的语言偏好与无障碍需求。
    fields: ['languages', 'accessibility', 'dietary_notes'],
    ttlMs: null, // 随授权撤回而失效，本身不设短期到期。
  },
  doc_verification: {
    name: '旅行文件核验结果',
    // 只有核验结论与有效期，不含证件号原件；证件号永不出现在交接包中。
    fields: ['document_status', 'visa_type', 'valid_until', 'verification_ref'],
    ttlMs: 30 * 24 * 60 * 60 * 1000, // 核验结果自交接起 30 天到期失效。
  },
  payment_help: {
    name: '支付帮助',
    fields: ['preferred_channels', 'help_status', 'retry_required'],
    ttlMs: 7 * 24 * 60 * 60 * 1000, // 支付帮助记录 7 天失效。
  },
  transport_arrangement: {
    name: '交通安排',
    fields: ['route', 'scheduled_at', 'seats', 'accessible_vehicle'],
    ttlMs: 2 * 24 * 60 * 60 * 1000, // 班次结束后短期失效。
  },
  reception_confirmation: {
    name: '接待确认',
    fields: ['site', 'booking_ref', 'scheduled_at', 'party_size'],
    ttlMs: 2 * 24 * 60 * 60 * 1000,
  },
  relay_contact: {
    name: '接力联系方式',
    // 本次旅次的临时匿名联络码，不是手机号或邮箱。
    fields: ['relay_channel_id'],
    // 全程有效，但随撤回立即停止使用、随旅次关闭抹除，不设固定 TTL。
    ttlMs: null,
  },
};

// 环节 → 服务方 → 所需分组的显式矩阵。由 STAGES 生成，避免两处维护。
export function buildNeedMatrix() {
  const matrix = {};
  for (const stage of STAGES) {
    matrix[stage.id] = { providerId: stage.providerId, groups: [...stage.needs] };
  }
  return matrix;
}

// 阻断点分类只允许这三类行业视角，统计模块不接受更细的个人维度。
export const BLOCKER_DOMAINS = {
  clearance: '通关堵点',
  payment: '支付堵点',
  reception: '接待堵点',
};
