import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;
export const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, removeAdditional: false });
addFormats(ajv);

export function assertValid<T>(validator: ValidateFunction<T>, value: unknown, label = '请求'): asserts value is T {
  if (!validator(value)) throw new ValidationError(`${label}校验失败`, validator.errors || []);
}

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string, readonly details: ErrorObject[]) { super(message); }
}
