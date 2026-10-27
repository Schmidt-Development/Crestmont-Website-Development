// Tests use the same node:sqlite D1 adapter and migration runner as the development server.
import { openDb, type SqliteDb } from "../../dev/sqlite-d1.ts";

export function createTestDb(): SqliteDb {
  return openDb(":memory:");
}
