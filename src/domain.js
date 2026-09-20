// 读取并检查项目共享的领域资料。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  if (!value.domain || !value.version || !value.sample_id || !Array.isArray(value.actors) || value.actors.length < 2 || !Array.isArray(value.facts) || value.facts.length < 2 || !Array.isArray(value.constraints) || value.constraints.length < 2) {
    throw new Error('共享资料缺少必要字段');
  }
  return value;
}
