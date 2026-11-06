// A minimal ZIP writer, for testing the reader on real archive bytes.
//
// Deliberately able to produce MALFORMED archives — a wrong CRC, a local header that lies about its size, a
// deflate stream that expands past what it declares. A reader tested only against well-formed input has not been
// tested on the thing it exists to defend against.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipFile {
  path: string;
  body?: Buffer | string;
  /** 0 = stored, 8 = deflate. Default: deflate. */
  method?: number;
  /** Unix mode for the external attributes. Default 0o100644 (regular file). */
  mode?: number;
  /** Write this as the uncompressed size in both headers instead of the real one. */
  lieSize?: number;
  /** Write this as the uncompressed size in the LOCAL header only (the reader must not trust it). */
  lieLocalSize?: number;
  /** Write a wrong CRC. */
  lieCrc?: number;
  /** Set the "encrypted" flag bit. */
  encrypted?: boolean;
  /** Use an unsupported compression method number. */
  rawMethod?: number;
}

const LINK_MODE = 0o120777;
const DIR_MODE = 0o040755;

/** A symlink entry: its "content" is the target path, and its mode marks it as a link. */
export const symlink = (path: string, target: string): ZipFile => ({ path, body: target, mode: LINK_MODE, method: 0 });
export const dir = (path: string): ZipFile => ({ path: path.endsWith("/") ? path : `${path}/`, body: "", mode: DIR_MODE, method: 0 });

export function makeZip(files: readonly ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const body = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body ?? "", "utf8");
    const method = f.rawMethod ?? f.method ?? 8;
    const data = method === 8 ? deflateRawSync(body) : body;
    const name = Buffer.from(f.path, "utf8");
    const crc = f.lieCrc ?? (crc32(body) >>> 0);
    const uncompressed = f.lieSize ?? body.length;
    const mode = f.mode ?? 0o100644;
    const flags = f.encrypted ? 0x0001 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(f.lieLocalSize ?? uncompressed, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);              // made by UNIX, so the external attributes carry a mode
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(uncompressed, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);

    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/** A complete, clean Vite + React + TypeScript project, as a real archive under a single top-level folder. */
export function viteProjectZip(root = "summit-haul-frontend"): Buffer {
  const at = (p: string) => (root ? `${root}/${p}` : p);
  return makeZip([
    dir(root),
    { path: at("package.json"), body: JSON.stringify({
      name: "summit-haul", private: true, type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
      devDependencies: { vite: "5.4.8", typescript: "5.6.2", "@vitejs/plugin-react": "4.3.1" },
    }, null, 2) },
    { path: at("package-lock.json"), body: JSON.stringify({ lockfileVersion: 3, name: "summit-haul" }) },
    { path: at("tsconfig.json"), body: JSON.stringify({ compilerOptions: { jsx: "react-jsx", strict: true } }) },
    { path: at("vite.config.ts"), body: "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n" },
    { path: at("index.html"), body: '<!doctype html><html><head><title>Summit Haul</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>' },
    { path: at("src/main.tsx"), body: "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n" },
    { path: at("src/App.tsx"), body: "export default function App() { return <main><h1>Summit Haul Co.</h1></main>; }\n" },
    { path: at("src/styles.css"), body: ":root{--forest:#1F3D2B;--sand:#E8DCC8;--amber:#D98324}body{margin:0;font-family:Inter,sans-serif}" },
    { path: at("public/logo.svg"), body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#1F3D2B"/></svg>' },
  ]);
}

/** Zip a real directory on disk, so a fixture project becomes the archive the import pipeline receives. */
export function zipDirectory(root: string, opts: { prefix?: string; skip?: RegExp } = {}): Buffer {
  const skip = opts.skip ?? /(^|[\/])(node_modules|dist|build|\.git|\.crestmont|\.vite)([\/]|$)/;
  const files: ZipFile[] = [];

  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (skip.test(r)) continue;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) files.push({ path: opts.prefix ? `${opts.prefix}/${r}` : r, body: readFileSync(abs) });
    }
  };
  walk(root, "");
  if (opts.prefix) files.unshift(dir(opts.prefix));
  return makeZip(files);
}
