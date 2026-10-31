// Multiple coordinated sessions for one website (Founder V3 §6).
//
// One authoritative specification (SPEC.json) splits the work into tasks with owned paths and dependencies. The
// coordinator runs the tasks layer by layer (a task starts after its dependencies): within a layer, tasks whose
// owned paths do not overlap run in parallel, each in its own git worktree and branch, up to the worker's session
// limit (hardware/plan-bound). Each session's result is committed on its branch and merged into the website's branch
// one at a time. A session that touched files outside its owned paths, or whose merge conflicts, is not merged: its
// task is re-run afterwards on the merged branch by a single session, so concurrent sessions never make conflicting
// changes. Every session has a task, an owner (the worker), an output contract and a completion record.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { run } from "../exec.ts";
import { commitAll, type GitCtx } from "../git.ts";

export interface SessionTask { id: string; title: string; workstream: string; paths: string[]; dependsOn: string[] }
export interface SessionRecord {
  id: string; role: "builder"; workstream: string; tasks: string[]; ownedPaths: string[];
  mode: "parallel" | "serial"; status: "merged" | "completed" | "rerun_serially" | "failed"; note: string | null; changedFiles: string[];
}
export type RunSession = (s: { id: string; tasks: SessionTask[]; cwd: string; ownedPaths: string[] }) => Promise<{ ok: boolean; error?: string | null }>;

const norm = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const overlaps = (a: string[], b: string[]) => a.some((x) => b.some((y) => { const nx = norm(x), ny = norm(y); return nx === ny || nx.startsWith(`${ny}/`) || ny.startsWith(`${nx}/`) || !nx || !ny; }));
const owns = (paths: string[], file: string) => paths.some((p) => { const n = norm(p); return !n || file === n || file.startsWith(`${n}/`); });

/** Topological layers; tasks with unknown dependencies wait for the end. */
export function layers(tasks: SessionTask[]): SessionTask[][] {
  const done = new Set<string>(), out: SessionTask[][] = [];
  let rest = [...tasks];
  while (rest.length) {
    const ready = rest.filter((t) => t.dependsOn.every((d) => done.has(d) || !tasks.some((x) => x.id === d)));
    const layer = ready.length ? ready : [rest[0]]; // a cycle (refused by the platform) degrades to serial order
    out.push(layer);
    for (const t of layer) done.add(t.id);
    rest = rest.filter((t) => !layer.includes(t));
  }
  return out;
}

/** Group one layer into at most `max` sessions with disjoint owned paths (overlapping tasks share a session). */
export function groupLayer(layer: SessionTask[], max: number): SessionTask[][] {
  const groups: { tasks: SessionTask[]; paths: string[] }[] = [];
  for (const t of layer) {
    const paths = t.paths.length ? t.paths : [""];
    const hit = groups.find((g) => overlaps(g.paths, paths));
    if (hit) { hit.tasks.push(t); hit.paths.push(...paths); continue; }
    if (groups.length < Math.max(1, max)) groups.push({ tasks: [t], paths: [...paths] });
    else { const g = groups.reduce((a, b) => (a.tasks.length <= b.tasks.length ? a : b)); g.tasks.push(t); g.paths.push(...paths); }
  }
  // Groups that ended up overlapping after the fallback merge are merged into one.
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    if (overlaps(groups[i].paths, groups[j].paths)) { groups[i].tasks.push(...groups[j].tasks); groups[i].paths.push(...groups[j].paths); groups.splice(j, 1); j = i; }
  }
  return groups.map((g) => g.tasks);
}

async function git(ctx: GitCtx, args: string[]) {
  return run("git", args, { cwd: ctx.repo, env: { PATH: ctx.pathEnv, HOME: ctx.home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 });
}

/** Runner-provisioned (gitignored) files every session needs: brief, spec, customer files, Claude settings, skills. */
const PROVISIONED = ["BRIEF.json", "BRIEF.md", "SPEC.json", "SPEC.md", "REVISION-REQUEST.md", "customer-files", ".claude", ".crestmont"];

export async function runCoordinatedSessions(o: { git: GitCtx; workDir: string; tasks: SessionTask[]; maxSessions: number; runSession: RunSession; shouldStop: () => boolean }): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let n = 0;
  const serial = async (tasks: SessionTask[], note: string | null) => {
    const id = `s${++n}`;
    const owned = tasks.flatMap((t) => t.paths);
    const r = await o.runSession({ id, tasks, cwd: o.git.repo, ownedPaths: owned });
    await commitAll(o.git, `AI build session ${id}: ${tasks.map((t) => t.id).join(", ")}`);
    records.push({ id, role: "builder", workstream: tasks[0]?.workstream ?? "general", tasks: tasks.map((t) => t.id), ownedPaths: owned, mode: "serial", status: r.ok ? "completed" : "failed", note: note ?? r.error ?? null, changedFiles: [] });
  };
  for (const layer of layers(o.tasks)) {
    if (o.shouldStop()) break;
    const groups = groupLayer(layer, o.maxSessions);
    if (groups.length <= 1) { await serial(layer, null); continue; }
    await commitAll(o.git, "AI build: before parallel sessions");
    const sessions = groups.map((tasks) => ({ id: `s${++n}`, tasks, owned: tasks.flatMap((t) => t.paths) }));
    const prepared: { id: string; tasks: SessionTask[]; owned: string[]; dir: string; branch: string }[] = [];
    for (const s of sessions) {
      const dir = path.join(o.workDir, `wt-${s.id}`), branch = `cm-session-${s.id}`;
      rmSync(dir, { recursive: true, force: true });
      const add = await git(o.git, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
      if (add.code !== 0) { await serial(s.tasks, `worktree could not be created: ${add.stderr.slice(0, 200)}`); continue; }
      for (const f of PROVISIONED) { const src = path.join(o.git.repo, f); if (existsSync(src)) cpSync(src, path.join(dir, f), { recursive: true }); }
      mkdirSync(path.join(dir, ".crestmont"), { recursive: true });
      prepared.push({ ...s, dir, branch });
    }
    const results = await Promise.all(prepared.map((s) => o.runSession({ id: s.id, tasks: s.tasks, cwd: s.dir, ownedPaths: s.owned }).catch((err) => ({ ok: false, error: String(err) }))));
    const rerun: { tasks: SessionTask[]; note: string }[] = [];
    for (const [i, s] of prepared.entries()) {
      const wt: GitCtx = { ...o.git, repo: s.dir };
      await commitAll(wt, `AI build session ${s.id}: ${s.tasks.map((t) => t.id).join(", ")}`);
      const changed = (await git(o.git, ["diff", "--name-only", `HEAD...${s.branch}`])).stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      const outside = s.owned.length ? changed.filter((f) => !owns(s.owned, f)) : [];
      const rec: SessionRecord = { id: s.id, role: "builder", workstream: s.tasks[0].workstream, tasks: s.tasks.map((t) => t.id), ownedPaths: s.owned, mode: "parallel", status: "merged", note: null, changedFiles: changed.slice(0, 200) };
      if (!results[i].ok) { rec.status = "failed"; rec.note = results[i].error ?? "session failed"; rerun.push({ tasks: s.tasks, note: `parallel session ${s.id} failed` }); }
      else if (outside.length) { rec.status = "rerun_serially"; rec.note = `changed files outside its owned paths: ${outside.slice(0, 5).join(", ")}`; rerun.push({ tasks: s.tasks, note: `session ${s.id} left its owned paths` }); }
      else if (changed.length) {
        const m = await git(o.git, ["merge", "--no-ff", "--no-edit", "-m", `Merge session ${s.id} (${s.tasks.map((t) => t.id).join(", ")})`, s.branch]);
        if (m.code !== 0) { await git(o.git, ["merge", "--abort"]); rec.status = "rerun_serially"; rec.note = "merge conflict with another session"; rerun.push({ tasks: s.tasks, note: `session ${s.id} conflicted` }); }
      } else rec.status = "completed";
      records.push(rec);
      await git(o.git, ["worktree", "remove", "--force", s.dir]);
      await git(o.git, ["branch", "-D", s.branch]);
    }
    for (const r of rerun) { if (o.shouldStop()) break; await serial(r.tasks, `${r.note}; re-run on the merged branch`); }
  }
  return records;
}
