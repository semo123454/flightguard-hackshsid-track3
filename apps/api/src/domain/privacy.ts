export function redactText(value: string): { value: string; redacted: boolean } {
  const redacted = value
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '[手机号已移除]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已移除]')
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号已移除]')
    .replace(/(?:姓名|旅客|乘客|员工)\s*[:：]\s*[^，,。；;\s]{1,20}/g, '[姓名已移除]');
  return { value: redacted, redacted: redacted !== value };
}

export function redactEvent<T>(input: T): { value: T; redacted: boolean } {
  let changed = false;
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = redactText(value);
      changed ||= result.redacted;
      return result.value;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return { value: visit(input) as T, redacted: changed };
}
