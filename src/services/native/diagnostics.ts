// Native-readiness diagnosis (Owner, 2026-11-19, "SELF-DIAGNOSIS AND SAFE AUTO-REPAIR"): one reusable catalogue of the
// reasons a website is or is not shown natively — never hardcoded per domain. Each diagnosis has
//   • a stable code (stored in native_diagnosis, audit rows and developer reports);
//   • a plain-English owner message (Staff → Portfolio shows only this by default);
//   • whether it is a failure of the FRAME (embedding-specific: Crestmont must fix it before verification succeeds) or
//     of the WEBSITE itself (the same with or without Crestmont: it is reported, never blamed on the iframe);
//   • the automatic repair Crestmont applies (idempotent, bounded, reversible) — or the one action a person must take;
//   • how the repair is verified and rolled back.
// The orchestrator (orchestrator.ts) records the diagnosis on every transition; the verifier (verify.ts) supplies the
// visual and performance findings.
import type { NativeState, PortfolioProject } from "../portfolio.ts";

export type DiagCode =
  | "framing_refused_csp" | "framing_refused_xfo" | "csp_conflict" | "csp_unstable" | "dns_only" | "not_owned"
  | "no_connection" | "repo_unlinked" | "repo_readonly" | "unsupported_headers" | "deployment_failed" | "deployment_pending"
  | "rule_no_effect" | "pr_awaiting_merge" | "pr_closed" | "site_unreachable" | "frame_not_loaded" | "blank_in_frame"
  | "iframe_render_failure" | "site_render_defect" | "js_module_error" | "hydration_failure" | "gpu_limited"
  | "iframe_overhead" | "site_slow" | "interaction_blocked" | "scroll_blocked" | "mobile_overflow"
  | "protected_route_exposed" | "verification_budget" | "verifier_unavailable" | "regression" | "stale_record"
  | "evidence_missing" | "protected_link_in_frame";

export interface DiagSpec { owner: string; embedFailure: boolean; repair: string; verify: string; rollback: string; action?: string }

/** The catalogue. `repair` is what Crestmont does by itself; `action` (if any) is the single thing a person must do. */
export const CATALOGUE: Record<DiagCode, DiagSpec> = {
  protected_link_in_frame: { owner: "A sign-in, booking or checkout link on the website opens inside Crestmont's frame, where that page can't be shown.", embedFailure: false, repair: "None in Crestmont: a link inside the website decides where it opens.", verify: "A real click on the link inside the frame must leave the frame on the site.", rollback: "—", action: "Make the website's sign-in, sign-up, booking and checkout links open in a new tab (target=\"_blank\" rel=\"noopener\")." },
  framing_refused_csp: { owner: "The website's security settings don't allow it to be shown inside Crestmont yet.", embedFailure: true, repair: "Allow only Crestmont's exact origins on the site's public pages, through the account that hosts it (Cloudflare rule, vercel.json or _headers).", verify: "Read the live public pages' headers, then a real-browser verification.", rollback: "Remove Crestmont's rule, or revert its pull request." },
  framing_refused_xfo: { owner: "The website's security settings don't allow it to be shown inside Crestmont yet.", embedFailure: true, repair: "Replace X-Frame-Options on public pages with a frame-ancestors list of Crestmont's exact origins.", verify: "Live headers, then a real-browser verification.", rollback: "Remove Crestmont's rule, or revert its pull request." },
  csp_conflict: { owner: "The website sends more than one security policy, so Crestmont can't safely adjust it automatically.", embedFailure: true, repair: "None automatic: a single rule cannot rewrite several policies safely.", verify: "—", rollback: "—", action: "Combine the site's Content-Security-Policy headers into one (or set frame-ancestors for Crestmont's origins on public pages) in the site's own code." },
  csp_unstable: { owner: "The website's security policy changes on every visit, so Crestmont can't adjust it automatically.", embedFailure: true, repair: "None automatic: a rule can only match a fixed policy.", verify: "—", rollback: "—", action: "Set frame-ancestors for Crestmont's origins on the site's public pages in its own code (its policy contains a per-request value)." },
  dns_only: { owner: "This domain is in your Cloudflare account, but its traffic doesn't go through Cloudflare, so Crestmont can't adjust it there.", embedFailure: true, repair: "Use the deployment's own configuration (Vercel / Pages / repository) when a connected account serves it.", verify: "Live headers.", rollback: "—", action: "Connect the account that actually serves this site, or turn on Cloudflare proxying for it." },
  not_owned: { owner: "None of your connected accounts hosts this website, so Crestmont won't change it.", embedFailure: true, repair: "None — Crestmont never changes a website it cannot prove you control.", verify: "—", rollback: "—", action: "Connect the hosting account (Cloudflare, Vercel or GitHub) that serves this website." },
  no_connection: { owner: "No hosting account is connected yet.", embedFailure: true, repair: "None until a connection exists.", verify: "—", rollback: "—", action: "Connect your Cloudflare, Vercel or GitHub account once (Worker secrets)." },
  repo_unlinked: { owner: "The hosting project isn't linked to a repository Crestmont can update.", embedFailure: true, repair: "None automatic.", verify: "—", rollback: "—", action: "Link the project to its GitHub repository in the hosting provider." },
  repo_readonly: { owner: "The GitHub connection can read the website's repository but not update it.", embedFailure: true, repair: "None until write access exists.", verify: "—", rollback: "—", action: "Give the GitHub connection write access to this repository." },
  unsupported_headers: { owner: "The website's deployment sets its headers in a way Crestmont can't safely edit automatically.", embedFailure: true, repair: "None automatic.", verify: "—", rollback: "—", action: "Add Crestmont's frame-ancestors to the site's public pages in its own configuration." },
  deployment_failed: { owner: "The website's latest deployment failed, so the change isn't live yet.", embedFailure: true, repair: "Re-check automatically after each new deployment.", verify: "Provider deployment state, then live headers.", rollback: "Revert the pull request.", action: "Fix the failing deployment in the hosting provider." },
  deployment_pending: { owner: "The website is being deployed with the change.", embedFailure: true, repair: "Follow the deployment.", verify: "Provider deployment state, then live headers.", rollback: "Revert the pull request." },
  rule_no_effect: { owner: "Crestmont's Cloudflare change didn't take effect on this website, so it was removed again.", embedFailure: true, repair: "Rule removed automatically; the header must be set where responses are produced.", verify: "Live headers after 10 minutes.", rollback: "Already rolled back.", action: "Set frame-ancestors for Crestmont's origins on public pages in the site's own code." },
  pr_awaiting_merge: { owner: "Waiting for your approval: review and merge one pull request.", embedFailure: true, repair: "Crestmont opened one pull request and continues after the merge.", verify: "Merge, deployment, live headers, real browser.", rollback: "Revert the pull request.", action: "Review and merge the pull request." },
  pr_closed: { owner: "The header change was closed without merging.", embedFailure: true, repair: "Not reopened automatically.", verify: "—", rollback: "—", action: "Use “Check again” to propose it again." },
  site_unreachable: { owner: "The website didn't answer.", embedFailure: true, repair: "Re-checked automatically.", verify: "Live check.", rollback: "—" },
  frame_not_loaded: { owner: "The website didn't load inside Crestmont's frame.", embedFailure: true, repair: "Re-check headers and prepare again.", verify: "Real-browser verification.", rollback: "—" },
  blank_in_frame: { owner: "The website loaded but showed nothing inside Crestmont's frame.", embedFailure: true, repair: "Compare with the direct visit; prepare again if only the frame is blank.", verify: "Real-browser verification, direct and framed.", rollback: "—" },
  iframe_render_failure: { owner: "An important animation works on the website directly but not inside Crestmont.", embedFailure: true, repair: "Diagnose the frame (permissions, sandbox, sizing) and verify again.", verify: "Direct-vs-framed comparison in the same browser.", rollback: "—" },
  site_render_defect: { owner: "An important animation on the website itself doesn't render — also when visited directly. It's a website problem, not a Crestmont one.", embedFailure: false, repair: "None in Crestmont: the frame shows the site exactly as visitors see it.", verify: "Direct-vs-framed comparison.", rollback: "—", action: "Fix the website's animation (details in the developer report)." },
  js_module_error: { owner: "The website has a script error that stops part of it from working.", embedFailure: false, repair: "None in Crestmont.", verify: "Direct-vs-framed comparison.", rollback: "—", action: "Fix the website's script error (details in the developer report)." },
  hydration_failure: { owner: "The website's page didn't finish starting up.", embedFailure: false, repair: "None in Crestmont.", verify: "Direct-vs-framed comparison.", rollback: "—", action: "Fix the website's start-up error." },
  gpu_limited: { owner: "The test browser couldn't judge a 3D animation (no graphics card); this isn't counted against the website.", embedFailure: false, repair: "Reported as a limitation, never as a pass or a failure.", verify: "A GPU-capable browser.", rollback: "—" },
  iframe_overhead: { owner: "The website is noticeably slower inside Crestmont than on its own.", embedFailure: true, repair: "Diagnose Crestmont's frame (lazy loading, sizing, other frames) and measure again.", verify: "Direct-vs-framed performance.", rollback: "—" },
  site_slow: { owner: "The website itself is slow (also when visited directly).", embedFailure: false, repair: "None in Crestmont.", verify: "Direct performance.", rollback: "—", action: "Improve the website's own performance (details in the developer report)." },
  interaction_blocked: { owner: "Clicks don't reach the website inside Crestmont.", embedFailure: true, repair: "Diagnose overlays and the frame's pointer handling.", verify: "Real click in the frame.", rollback: "—" },
  scroll_blocked: { owner: "The website doesn't scroll inside Crestmont.", embedFailure: true, repair: "Diagnose the frame's scroll handling.", verify: "Real wheel gesture in the frame.", rollback: "—" },
  mobile_overflow: { owner: "On phones the website is wider than the screen.", embedFailure: false, repair: "None in Crestmont.", verify: "390 px check.", rollback: "—", action: "Fix the website's mobile layout." },
  protected_route_exposed: { owner: "A sign-in, checkout or account page could be shown inside Crestmont — Crestmont won't display the site until it can't.", embedFailure: true, repair: "Narrow the change to public pages only.", verify: "Protected pages' headers.", rollback: "Remove the change.", action: "Make the site's sensitive pages refuse framing." },
  verification_budget: { owner: "Today's automatic checks are used up; it continues automatically within a day.", embedFailure: false, repair: "Resumes automatically.", verify: "—", rollback: "—" },
  verifier_unavailable: { owner: "The test browser isn't available right now; it continues automatically.", embedFailure: false, repair: "Resumes automatically.", verify: "—", rollback: "—" },
  regression: { owner: "The website stopped allowing Crestmont after a later update; Crestmont is repairing it.", embedFailure: true, repair: "Re-apply the same narrowly scoped change (idempotent) and verify again.", verify: "Live headers, real browser.", rollback: "Remove the change." },
  stale_record: { owner: "The last check is old; Crestmont is checking again.", embedFailure: false, repair: "Re-check.", verify: "Live check.", rollback: "—" },
  evidence_missing: { owner: "There's no verification on record yet; Crestmont is testing the website.", embedFailure: false, repair: "Run the verification.", verify: "Real-browser verification.", rollback: "—" },
};

export interface Diagnosis { codes: DiagCode[]; owner: string; embedFailure: boolean; action: string | null; at: string; developer: string }

/** Builds the stored diagnosis from codes and the developer detail (the orchestrator's exact reason). */
export function diagnose(codes: DiagCode[], developer: string, at = new Date().toISOString()): Diagnosis {
  const uniq = [...new Set(codes)];
  const first = uniq.map((c) => CATALOGUE[c]).find((x) => x.embedFailure) ?? uniq.map((c) => CATALOGUE[c])[0];
  return {
    codes: uniq,
    owner: uniq.length ? uniq.map((c) => CATALOGUE[c].owner).filter((v, i, a) => a.indexOf(v) === i).join(" ") : "",
    embedFailure: uniq.some((c) => CATALOGUE[c].embedFailure),
    action: first?.action ?? null,
    at, developer: developer.slice(0, 1500),
  };
}

/** Classifies an orchestrator reason (the exact text it records) into diagnosis codes. Patterns only match text this
 *  codebase writes itself, so a new reason without a code simply shows its own words. */
export function codesFor(state: NativeState, reason: string): DiagCode[] {
  const r = reason.toLowerCase(), out: DiagCode[] = [];
  const has = (re: RegExp) => re.test(r);
  if (has(/^regression|stopped permitting framing/)) out.push("regression");
  if (has(/more than one content-security-policy/)) out.push("csp_conflict");
  if (has(/changes between requests|per-request nonce/)) out.push("csp_unstable");
  if (has(/not proxied by cloudflare \(dns only\)/) && state !== "native_verified") out.push("dns_only");
  if (has(/not served by any connected account/)) out.push("not_owned");
  if (has(/no hosting or repository connection is configured/)) out.push("no_connection");
  if (has(/not linked to a github repository/)) out.push("repo_unlinked");
  if (has(/cannot push to it|connect github/)) out.push("repo_readonly");
  if (has(/no existing _headers file|cannot tell which folder/)) out.push("unsupported_headers");
  if (has(/deployment .* failed|the deployment of .* failed/)) out.push("deployment_failed");
  if (has(/waiting for the deployment|; building|merged .*; /) && state === "preparing") out.push("deployment_pending");
  if (has(/did not take effect within 10 minutes/)) out.push("rule_no_effect");
  if (has(/waiting for your approval/)) out.push("pr_awaiting_merge");
  if (has(/closed without merging/)) out.push("pr_closed");
  if (has(/could not be checked|did not answer|could not reach/)) out.push("site_unreachable");
  if (has(/did not load .* inside crestmont's frame|frame did not load/)) out.push("frame_not_loaded");
  if (has(/blank or stuck loading/)) out.push("blank_in_frame");
  if (has(/only inside crestmont|only in the frame/)) out.push("iframe_render_failure");
  if (has(/also when visited directly|in both direct and framed/)) out.push("site_render_defect");
  if (has(/failed to resolve module specifier|module script/)) out.push("js_module_error");
  if (has(/no webgl|software webgl|gpu/)) out.push("gpu_limited");
  if (has(/slower inside crestmont/)) out.push("iframe_overhead");
  if (has(/website itself is slow/)) out.push("site_slow");
  if (has(/click .* did not reach/)) out.push("interaction_blocked");
  if (has(/did not scroll the site/)) out.push("scroll_blocked");
  if (has(/link inside crestmont's frame loads/)) out.push("protected_link_in_frame");
  if (has(/wider than the screen/) && state !== "native_verified") out.push("mobile_overflow");
  if (has(/sensitive page\(s\) .* permit framing/)) out.push("protected_route_exposed");
  if (has(/real-browser verifications .* are used up/)) out.push("verification_budget");
  if (has(/no verification browser is available|verification browser failed/)) out.push("verifier_unavailable");
  if (has(/refuses framing|frame-ancestors|x-frame-options/) && !out.length && state !== "native_verified") out.push(has(/x-frame-options/) && !has(/frame-ancestors/) ? "framing_refused_xfo" : "framing_refused_csp");
  return out;
}

/** The five plain-English stages the owner sees (Owner, 2026-11-19, "OWNER EXPERIENCE"). */
export const STAGES = ["Finding your website", "Preparing native compatibility", "Testing the real website", "Optimizing and verifying", "Ready for portfolio publication"] as const;
export interface OwnerProgress { stage: number; label: string; done: boolean; attention: boolean; message: string; action: string | null }

/** Where an entry is, in the owner's words: which of the five stages, and — only when a person must act — what to do. */
export function ownerProgress(p: Pick<PortfolioProject, "native_state" | "native_reason" | "native_diagnosis" | "native_provider" | "embed_status" | "native_verification">): OwnerProgress {
  const st = p.native_state ?? "checking";
  let d: Diagnosis | null = null;
  try { d = p.native_diagnosis ? JSON.parse(p.native_diagnosis) as Diagnosis : null; } catch { d = null; }
  const codes = d?.codes ?? codesFor(st, p.native_reason ?? "");
  const message = d?.owner || (codes.length ? diagnose(codes, "").owner : "");
  const action = d?.action ?? (codes.length ? diagnose(codes, "").action : null);
  if (st === "native_verified") return { stage: 4, label: STAGES[4], done: true, attention: false, message: "The real website is verified in Crestmont's native frame.", action: null };
  if (st === "authorization_required" || st === "unavailable") {
    const stage = p.native_provider ? (p.embed_status === "allowed" ? 2 : 1) : 0;
    return { stage, label: STAGES[stage], done: false, attention: true, message: message || "Crestmont can't finish this website automatically.", action };
  }
  if (st === "preparing") return { stage: 1, label: STAGES[1], done: false, attention: false, message: message || "Crestmont is preparing the website's public pages.", action: null };
  // checking: the site already permits Crestmont → testing; otherwise still finding it.
  const stage = p.embed_status === "allowed" ? (p.native_verification ? 3 : 2) : 0;
  return { stage, label: STAGES[stage], done: false, attention: false, message: message || "Crestmont is working on it — nothing for you to do.", action: null };
}
