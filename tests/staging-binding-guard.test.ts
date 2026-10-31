// Founder-managed configuration survives staging deploys (2026-10-31: a `wrangler deploy` without --keep-vars deleted
// the Founder's dashboard-set STRIPE_PUBLISHABLE_KEY). Static checks of the deploy workflow and wrangler.toml, and the
// guard's logic against FIXTURE Cloudflare API results (no real API is called; no real values are used).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { FOUNDER_MANAGED, tomlEnvVars, tomlScriptName, summarize, preflightProblems, verifyProblems, founderReport, liveBindings, type BindingSummary } from "../scripts/staging-binding-guard.ts";

const toml = readFileSync("wrangler.toml", "utf8");
const staging = readFileSync(".github/workflows/deploy-staging.yml", "utf8");

test("[INFRA-002] the staging deploy keeps dashboard variables (--keep-vars) and is wrapped by the preservation guard", () => {
  const deploys = [...staging.matchAll(/\$WRANGLER deploy\b[^\n|]*/g)].map((m) => m[0]);
  assert.deepEqual(deploys, ["$WRANGLER deploy --env staging --keep-vars "], "the only staging deploy passes --keep-vars");
  const at = (s: string) => { const i = staging.indexOf(s); assert.ok(i > 0, s); return i; };
  const preflight = at("scripts/staging-binding-guard.ts snapshot");
  assert.ok(preflight < at("d1 migrations apply crestmont-staging"), "the snapshot is taken before anything on staging changes");
  assert.ok(preflight < at("$WRANGLER deploy --env staging"));
  const verify = at("scripts/staging-binding-guard.ts verify");
  assert.ok(verify > at("$WRANGLER deploy --env staging"), "verified after the deploy");
  const verifyStep = staging.slice(staging.lastIndexOf("- name:", verify), verify);
  assert.doesNotMatch(verifyStep, /continue-on-error/, "a failed verification fails the deploy");
  assert.ok(verify < at("staging-secrets.ts put"), "verified before any secret is written");
});

test("[INFRA-002] no wrangler.toml environment declares a Founder-managed variable (a deploy would overwrite it)", () => {
  for (const env of ["staging", "production"]) assert.deepEqual(preflightProblems(tomlEnvVars(toml, env)), [], env);
  const top = toml.slice(0, toml.indexOf("[env."));
  for (const n of FOUNDER_MANAGED) assert.doesNotMatch(top.replace(/^#.*$/gm, ""), new RegExp(`\\b${n}\\s*=`), `top-level ${n}`);
  assert.equal(tomlScriptName(toml, "staging"), "crestmont-platform-staging");
  assert.equal(tomlEnvVars(toml, "staging").APP_URL, "https://crestmont-platform-staging.partners-df4.workers.dev");
  assert.match(preflightProblems({ STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" })[0], /Founder-managed STRIPE_PUBLISHABLE_KEY/);
});

test("[INFRA-002] no workflow or script writes, deletes or derives a Founder-managed Stripe value", () => {
  const files = [...readdirSync(".github/workflows").map((f) => `.github/workflows/${f}`), ...readdirSync("scripts").filter((f) => /\.(ts|mjs|sh)$/.test(f)).map((f) => `scripts/${f}`)];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const n of FOUNDER_MANAGED) {
      assert.doesNotMatch(src, new RegExp(`secret\\s+(put|delete)\\s+["']?${n}\\b|put\\s+${n}\\b|secret["'],\\s*["'](put|delete)["'],\\s*["']${n}`), `${f} must not write ${n}`);
    }
    assert.doesNotMatch(src, /secret\s+delete\b|["']secret["'],\s*["']delete["']|secret\s+bulk\b/, `${f} must not delete or bulk-replace Worker secrets`);
  }
  assert.ok(FOUNDER_MANAGED.includes("STRIPE_PUBLISHABLE_KEY"), "kept in the inventory although no code reads it");
});

test("[INFRA-002] binding summaries hash plain-text values and never carry a value", () => {
  const s = summarize({ bindings: [
    { name: "STRIPE_PUBLISHABLE_KEY", type: "plain_text", text: "pk_test_FIXTUREVALUE" },
    { name: "STRIPE_SECRET_KEY", type: "secret_text" },
    { name: "DB", type: "d1", id: "x" },
  ] })!;
  assert.equal(s.length, 3);
  assert.doesNotMatch(JSON.stringify(s), /pk_test_FIXTUREVALUE/, "no value is stored");
  assert.match(s.find((b) => b.name === "STRIPE_PUBLISHABLE_KEY")!.hash!, /^[0-9a-f]{64}$/);
  assert.equal(s.find((b) => b.name === "STRIPE_SECRET_KEY")!.hash, undefined, "secret values are not returned by Cloudflare");
  assert.equal(summarize({ result: "no bindings here" }), null);
  assert.deepEqual(founderReport(s), { present: ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"], absent: ["STRIPE_WEBHOOK_SECRET"] });
});

test("[INFRA-002] verification catches what a deploy without --keep-vars did, and allows wrangler.toml changes", () => {
  const before: BindingSummary[] = summarize({ bindings: [
    { name: "APP_URL", type: "plain_text", text: "https://old.example" },
    { name: "STRIPE_PUBLISHABLE_KEY", type: "plain_text", text: "pk_test_FIXTURE" },
    { name: "STRIPE_WEBHOOK_SECRET", type: "secret_text" },
  ] })!;
  const declared = { APP_URL: "https://new.example" };
  // The 2026-10-31 failure: the dashboard variable vanished.
  const lost = summarize({ bindings: [{ name: "APP_URL", type: "plain_text", text: "https://new.example" }, { name: "STRIPE_WEBHOOK_SECRET", type: "secret_text" }] })!;
  assert.deepEqual(verifyProblems(before, lost, declared), ["STRIPE_PUBLISHABLE_KEY (plain_text) was removed by the deploy"]);
  // A removed secret and a changed dashboard value are refused too.
  const changed = summarize({ bindings: [{ name: "APP_URL", type: "plain_text", text: "https://new.example" }, { name: "STRIPE_PUBLISHABLE_KEY", type: "plain_text", text: "pk_test_OTHER" }] })!;
  assert.deepEqual(verifyProblems(before, changed, declared), ["dashboard-managed STRIPE_PUBLISHABLE_KEY changed value during the deploy", "STRIPE_WEBHOOK_SECRET (secret_text) was removed by the deploy"]);
  // Preserved: only the repository-managed APP_URL changed.
  const kept = summarize({ bindings: [{ name: "APP_URL", type: "plain_text", text: "https://new.example" }, { name: "STRIPE_PUBLISHABLE_KEY", type: "plain_text", text: "pk_test_FIXTURE" }, { name: "STRIPE_WEBHOOK_SECRET", type: "secret_text" }] })!;
  assert.deepEqual(verifyProblems(before, kept, declared), []);
});

test("[INFRA-002] live bindings: script settings, else the serving version; refuses when neither returns bindings", async () => {
  const calls: string[] = [];
  const settingsApi = async (p: string) => { calls.push(p); return { bindings: [{ name: "X", type: "secret_text" }] }; };
  assert.deepEqual(await liveBindings("crestmont-platform-staging", settingsApi), [{ name: "X", type: "secret_text" }]);
  assert.deepEqual(calls, ["/workers/scripts/crestmont-platform-staging/settings"]);
  const vid = "0123abcd-0000-4000-8000-000000000001";
  const versionApi = async (p: string) => {
    if (p.endsWith("/settings")) throw new Error("not available");
    if (p.endsWith("/deployments")) return { deployments: [{ versions: [{ version_id: vid, percentage: 100 }] }] };
    if (p.endsWith(`/versions/${vid}`)) return { resources: { bindings: [{ name: "Y", type: "plain_text", text: "v" }] } };
    throw new Error(`unexpected ${p}`);
  };
  assert.equal((await liveBindings("crestmont-platform-staging", versionApi))[0].name, "Y");
  const none = async (p: string) => (p.endsWith("/deployments") ? { deployments: [{ versions: [{ version_id: vid, percentage: 100 }] }] } : {});
  await assert.rejects(liveBindings("crestmont-platform-staging", none), /no bindings/);
});
