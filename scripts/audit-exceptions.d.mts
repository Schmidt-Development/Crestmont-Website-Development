// Types for scripts/audit-exceptions.mjs (imported by tests/dependency-audit-gate.test.ts).
export interface AuditException { advisory: string; path: string; expires: string; approvedBy?: string; reason?: string }
export function blockingAdvisories(report: { vulnerabilities?: Record<string, { via?: unknown[] }> }): string[];
export function uncovered(advisories: string[], exceptions: AuditException[], dir: string, today: string): string[];
