import { createHash } from 'node:crypto';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

// Contract-owned canonicalization, not a claim of RFC 8785 compatibility.
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Non-finite numbers are not JSON');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Only JSON values are allowed');
    if (ancestors.has(item)) throw new TypeError('Cyclic JSON is not allowed');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Array.from({length: item.length}, (_, index) => index).some(index => !(index in item))) throw new TypeError('Sparse arrays are not JSON');
      result = `[${item.map(encode).join(',')}]`;
    } else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Only plain JSON objects are allowed');
      const record = item as Record<string, unknown>;
      result = `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value);
}
export const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const hashJson = (value: unknown): string => sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
