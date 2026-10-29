// CREST-GAP-102: a client cannot burst to twice the limit across a fixed-window boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./support/app.ts";
import { rateLimit } from "../src/services/security.ts";

test("[AUTH-005] rate limits weight the previous window, so a boundary burst cannot double the limit (CREST-GAP-102)", async () => {
  const { db } = await createTestApp();
  const w = 900, start = Math.floor(Date.now() / 1000 / w) * w * 1000;
  const endOfWindow = start + (w - 1) * 1000, nextWindow = start + w * 1000 + 1000;
  for (let i = 0; i < 10; i++) assert.ok((await rateLimit(db, "k", 10, w, endOfWindow)).allowed);
  assert.equal((await rateLimit(db, "k", 10, w, nextWindow)).allowed, false, "right after the boundary the previous burst still counts");
  const later = start + 2 * w * 1000 + 1000;
  assert.ok((await rateLimit(db, "k", 10, w, later)).allowed, "two windows later the budget is back");
});
