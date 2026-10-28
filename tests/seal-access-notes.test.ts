import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seal, open, SealError } from "../scripts/seal-access-notes.ts";

const PASS = "correct horse battery staple 2026";

test("[INFRA-002] [SEC-007] access notes: AES-256-GCM round trip; wrong passphrase, tampering and weak passphrases are refused", () => {
  const text = Buffer.from("# Staging access\nOwner password: example-only\n");
  const sealed = seal(text, PASS);
  assert.ok(!sealed.includes(text), "no plaintext in the sealed file");
  assert.deepEqual(open(sealed, PASS), text);
  assert.notDeepEqual(seal(text, PASS), sealed, "random salt and IV per seal");
  assert.throws(() => open(sealed, PASS + "x"), SealError);
  for (const at of [9, 30, 60, sealed.length - 1]) {
    const t = Buffer.from(sealed); t[at] ^= 0x01;
    assert.throws(() => open(t, PASS), SealError, `modified byte ${at} detected`);
  }
  assert.throws(() => seal(text, "short"), SealError);
  assert.throws(() => seal(text, ""), SealError);
});

test("[INFRA-002] seal CLI writes nothing and exits 3 without a strong passphrase; seals several files into one", () => {
  const dir = mkdtempSync(join(tmpdir(), "seal-"));
  try {
    writeFileSync(join(dir, "a.md"), "first secret part"); writeFileSync(join(dir, "b.md"), "second part");
    const out = join(dir, "notes.cmseal");
    const env = { ...process.env, ACCESS_ARTIFACT_PASSPHRASE: "" };
    const r = spawnSync(process.execPath, ["--no-warnings", "scripts/seal-access-notes.ts", "seal", "--out", out, join(dir, "a.md")], { env, encoding: "utf8" });
    assert.equal(r.status, 3);
    assert.equal(existsSync(out), false);
    execFileSync(process.execPath, ["--no-warnings", "scripts/seal-access-notes.ts", "seal", "--out", out, join(dir, "a.md"), join(dir, "b.md")], { env: { ...process.env, ACCESS_ARTIFACT_PASSPHRASE: PASS }, stdio: "pipe" });
    const plain = open(readFileSync(out), PASS).toString();
    assert.match(plain, /first secret part[\s\S]*second part/);
    execFileSync(process.execPath, ["--no-warnings", "scripts/seal-access-notes.ts", "open", "--in", out, "--out", join(dir, "o.md")], { env: { ...process.env, ACCESS_ARTIFACT_PASSPHRASE: PASS }, stdio: "pipe" });
    assert.equal(readFileSync(join(dir, "o.md"), "utf8"), plain);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
