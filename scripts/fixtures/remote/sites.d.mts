// Types for sites.mjs (used by dev/server.ts).
export type FixtureAnswer = { status: number; headers: Record<string, string>; body: string; record?: () => void } | { error: true };
export const FIXTURE_DOMAIN: string;
export const FIXTURES: string[];
export const EXPECTED_MODE: Record<string, "embed" | "remote" | "unavailable">;
export const LAYOUT: Record<string, { x: number; y: number }>;
export function fixtureState(name: string): Record<string, string> | null;
export function resetFixtureState(): void;
export function fixtureResponse(url: string, origin: string): FixtureAnswer | null;
