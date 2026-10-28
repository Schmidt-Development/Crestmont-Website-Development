// Authenticated encryption for the staging access notes (security remediation 2026-10-28, F-18).
//
// The repository is public, so any workflow artifact can be downloaded by anyone signed in to GitHub. Access notes
// therefore leave the runner only sealed with the Founder's ACCESS_ARTIFACT_PASSPHRASE secret:
//   key = scrypt(passphrase, random 16-byte salt, N=2^17, r=8, p=1) → AES-256-GCM, random 12-byte IV,
//   128-bit tag, the header bound as additional authenticated data. Any modification fails to decrypt.
// (The previous `openssl enc -aes-256-cbc` was unauthenticated: a modified file decrypted to altered text.)
//
// Seal (CI):   ACCESS_ARTIFACT_PASSPHRASE=… node --no-warnings scripts/seal-access-notes.ts seal --out notes.cmseal file1.md [file2.md …]
//              exits 3 (and writes nothing) when the passphrase is missing or shorter than 16 characters.
// Open (you):  node --no-warnings scripts/seal-access-notes.ts open --in staging-access.cmseal --out staging-access.md
//              prompts for the passphrase (or reads ACCESS_ARTIFACT_PASSPHRASE).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("CMSEAL1\n");
const N = 2 ** 17, R = 8, P = 1;
const MAXMEM = 256 * 1024 * 1024;
export const MIN_PASSPHRASE = 16;

export class SealError extends Error {}

function key(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFC"), salt, 32, { N, r: R, p: P, maxmem: MAXMEM });
}

export function seal(plaintext: Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) throw new SealError(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const c = createCipheriv("aes-256-gcm", key(passphrase, salt), iv);
  c.setAAD(header);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([header, c.getAuthTag(), body]);
}

export function open(sealed: Buffer, passphrase: string): Buffer {
  if (sealed.length < MAGIC.length + 16 + 12 + 16 || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError("not a Crestmont sealed file");
  const salt = sealed.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = sealed.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const tag = sealed.subarray(MAGIC.length + 28, MAGIC.length + 44);
  const d = createDecipheriv("aes-256-gcm", key(passphrase, salt), iv);
  d.setAAD(sealed.subarray(0, MAGIC.length + 28));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(sealed.subarray(MAGIC.length + 44)), d.final()]);
  } catch {
    throw new SealError("wrong passphrase, or the file was modified");
  }
}

async function askPassphrase(): Promise<string> {
  if (process.env.ACCESS_ARTIFACT_PASSPHRASE) return process.env.ACCESS_ARTIFACT_PASSPHRASE;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}; // do not echo
  process.stderr.write("Passphrase (ACCESS_ARTIFACT_PASSPHRASE): ");
  const v = await rl.question("");
  rl.close();
  process.stderr.write("\n");
  return v;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (cmd === "seal") {
      const out = opt("--out");
      const files = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--out");
      if (!out || !files.length) throw new SealError("usage: seal --out <file> <input…>");
      const pass = process.env.ACCESS_ARTIFACT_PASSPHRASE ?? "";
      if (pass.length < MIN_PASSPHRASE) { console.log(`::warning title=Access notes not issued::ACCESS_ARTIFACT_PASSPHRASE is missing or shorter than ${MIN_PASSPHRASE} characters; nothing was sealed or uploaded.`); process.exit(3); }
      const text = files.map((f) => readFileSync(f)).reduce((a, b) => Buffer.concat([a, Buffer.from("\n\n---\n\n"), b]));
      writeFileSync(out, seal(text, pass), { mode: 0o600 });
      console.log(`Sealed ${files.length} file(s) with AES-256-GCM.`);
    } else if (cmd === "open") {
      const inp = opt("--in"), out = opt("--out");
      if (!inp || !out) throw new SealError("usage: open --in <file.cmseal> --out <file.md>");
      writeFileSync(out, open(readFileSync(inp), await askPassphrase()), { mode: 0o600 });
      console.error(`Decrypted to ${out}. Delete it after use.`);
    } else throw new SealError("usage: seal-access-notes.ts seal|open …");
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(e instanceof SealError ? 2 : 1);
  }
}
