export class RuntimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RuntimeError'; this.code = code; }
}
export function requireState(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new RuntimeError(code, message);
}
