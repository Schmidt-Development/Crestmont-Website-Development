// Small dependency-free validator. Every external input passes through one of these
// before touching business logic or the database (SEC-001).

export class ValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Validation failed: ${issues.join("; ")}`);
    this.issues = issues;
  }
}

export interface Check<T> { (value: unknown, path: string, issues: string[]): T | undefined; readonly __out?: T }
type Opt<O, T> = O extends { optional: true } ? T | undefined : T;

export const v = {
  string<O extends { min?: number; max?: number; pattern?: RegExp; optional?: boolean }>(opts: O = {} as O): Check<Opt<O, string>> {
    return ((value, path, issues) => {
      if (value === undefined || value === null || value === "") {
        if (opts.optional) return undefined;
        issues.push(`${path} is required`);
        return undefined;
      }
      if (typeof value !== "string") { issues.push(`${path} must be a string`); return undefined; }
      const s = value.trim();
      if (opts.min !== undefined && s.length < opts.min) issues.push(`${path} must be at least ${opts.min} characters`);
      if (opts.max !== undefined && s.length > opts.max) issues.push(`${path} must be at most ${opts.max} characters`);
      if (opts.pattern && !opts.pattern.test(s)) issues.push(`${path} has an invalid format`);
      return s;
    }) as Check<Opt<O, string>>;
  },
  email<O extends { optional?: boolean }>(opts: O = {} as O): Check<Opt<O, string>> {
    return v.string({ ...opts, max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/ }) as Check<Opt<O, string>>;
  },
  enumOf<T extends string, O extends { optional?: boolean } = {}>(values: readonly T[], opts: O = {} as O): Check<Opt<O, T>> {
    return ((value, path, issues) => {
      if (value === undefined && opts.optional) return undefined;
      if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
        issues.push(`${path} must be one of ${values.join(", ")}`);
        return undefined;
      }
      return value as T;
    }) as Check<Opt<O, T>>;
  },
  int<O extends { min?: number; max?: number; optional?: boolean }>(opts: O = {} as O): Check<Opt<O, number>> {
    return ((value, path, issues) => {
      if (value === undefined && opts.optional) return undefined;
      if (typeof value !== "number" || !Number.isInteger(value)) { issues.push(`${path} must be an integer`); return undefined; }
      if (opts.min !== undefined && value < opts.min) issues.push(`${path} must be ≥ ${opts.min}`);
      if (opts.max !== undefined && value > opts.max) issues.push(`${path} must be ≤ ${opts.max}`);
      return value;
    }) as Check<Opt<O, number>>;
  },
  array<T>(item: Check<T>, opts: { max?: number } = {}): Check<T[]> {
    return (value, path, issues) => {
      if (!Array.isArray(value)) { issues.push(`${path} must be an array`); return undefined; }
      if (opts.max !== undefined && value.length > opts.max) issues.push(`${path} has too many items`);
      return value.map((x, i) => item(x, `${path}[${i}]`, issues) as T);
    };
  },
  object<S extends Record<string, Check<any>>>(shape: S): Check<{ [K in keyof S]: S[K] extends Check<infer T> ? T : never }> {
    return (value, path, issues) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) { issues.push(`${path || "body"} must be an object`); return undefined; }
      const out: Record<string, unknown> = {};
      for (const [k, check] of Object.entries(shape)) {
        const r = check((value as Record<string, unknown>)[k], path ? `${path}.${k}` : k, issues);
        if (r !== undefined) out[k] = r;
      }
      return out as { [K in keyof S]: S[K] extends Check<infer T> ? T : never };
    };
  },
};

export function parse<T>(check: Check<T>, value: unknown): T {
  const issues: string[] = [];
  const out = check(value, "", issues);
  if (issues.length) throw new ValidationError(issues);
  return out as T;
}
