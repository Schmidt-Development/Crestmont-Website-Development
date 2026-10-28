// Authenticated encryption for files the deploy workflows hand to the Founder through artifacts of a PUBLIC repository
// (staging access notes, the pre-rotation forensic snapshot). Anyone signed in to GitHub can download those artifacts,
// so their contents must be unreadable AND tamper-evident without the Founder's ACCESS_ARTIFACT_PASSPHRASE.
//
//   format  "CMSEAL1\n" (8 bytes) | scrypt salt (16) | AES-GCM iv (12) | ciphertext | GCM tag (16)
//   key     scrypt(passphrase, salt, N=2^17, r=8, p=1) → 32 bytes → AES-256-GCM; the 36-byte header is the AAD
//
// Standalone on purpose (Node built-ins only): the Founder can decrypt with this one file and Node ≥ 22.18.
//   seal:   ACCESS_ARTIFACT_PASSPHRASE=… node --no-warnings scripts/seal.ts seal <in> <out>
//   open:   node --no-warnings scripts/seal.ts open <in.sealed> [<out>]   (prompts for the passphrase without echo;
//           or reads ACCESS_ARTIFACT_PASSPHRASE; prints to the terminal unless <out> is given)
//   check:  node --no-warnings scripts/seal.ts check   → exit 0 only when ACCESS_ARTIFACT_PASSPHRASE is usable
// Nothing here prints a passphrase, a key or plaintext except `open` writing the plaintext where it was asked to.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAGIC = Buffer.from("CMSEAL1\n", "ascii");
export const MIN_PASSPHRASE = 32;
const SALT = 16, IV = 12, TAG = 16, HEADER = MAGIC.length + SALT + IV;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export class SealError extends Error {}

export function passphraseProblem(p: string | undefined): string | null {
  if (!p) return "ACCESS_ARTIFACT_PASSPHRASE is not configured";
  if (p.length < MIN_PASSPHRASE) return `ACCESS_ARTIFACT_PASSPHRASE is shorter than ${MIN_PASSPHRASE} characters`;
  if (new Set(p).size < 8) return "ACCESS_ARTIFACT_PASSPHRASE has too little variety (fewer than 8 distinct characters)";
  return null;
}

export function seal(plain: Buffer, passphrase: string): Buffer {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new SealError(problem);
  const salt = randomBytes(SALT), iv = randomBytes(IV);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const c = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv);
  c.setAAD(header);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([header, ct, c.getAuthTag()]);
}

export function open(sealed: Buffer, passphrase: string): Buffer {
  if (sealed.length < HEADER + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError("not a Crestmont sealed file");
  const header = sealed.subarray(0, HEADER);
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT), iv = header.subarray(MAGIC.length + SALT);
  const d = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv);
  d.setAAD(header);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([d.update(sealed.subarray(HEADER, sealed.length - TAG)), d.final()]);
  } catch {
    throw new SealError("wrong passphrase, or the file was modified");
  }
}

async function promptHidden(label: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return readFileSync(0, "utf8").replace(/\r?\n$/, "");
  stderr.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); stderr.write("\n"); fn(); };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(new SealError("cancelled")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1); else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, input, output] = process.argv.slice(2);
  try {
    if (mode === "check") {
      const problem = passphraseProblem(process.env.ACCESS_ARTIFACT_PASSPHRASE);
      if (problem) { console.error(problem); process.exit(1); }
      console.log("ACCESS_ARTIFACT_PASSPHRASE: usable");
    } else if (mode === "seal" && input && output) {
      writeFileSync(output, seal(readFileSync(input), process.env.ACCESS_ARTIFACT_PASSPHRASE ?? ""), { mode: 0o600 });
    } else if (mode === "open" && input) {
      const pass = process.env.ACCESS_ARTIFACT_PASSPHRASE || (await promptHidden("Passphrase: "));
      const plain = open(readFileSync(input), pass);
      if (output) writeFileSync(output, plain, { mode: 0o600 }); else process.stdout.write(plain);
    } else {
      throw new SealError("usage: seal <in> <out> | open <in> [<out>] | check");
    }
  } catch (e) {
    console.error(`${e instanceof SealError ? "" : "error: "}${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    process.exit(1);
  }
}
