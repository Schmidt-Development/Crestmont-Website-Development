# Founder-only actions (2026-11-09)

Everything engineering-controlled is finished and verified on staging; see
[MASTER-VERIFICATION-2026-11-08.md](MASTER-VERIFICATION-2026-11-08.md) for the evidence behind each of the 112 items.
This list holds only what needs your judgment, your accounts or your authorization. Nothing below asks you to read code,
run SQL, operate CI or inspect webhooks. Items are in the order to do them.

Staging: `https://crestmont-platform-staging.partners-df4.workers.dev`. Use the Owner and demo-customer sign-ins
from the sealed access notes of the latest staging deploy.

## Blocks production

| # | Action | Where | Time |
|---|---|---|---|
| F1 | **Approve the invoice and receipt appearance** (black, gold and white; "Invoice 001" / "Receipt 001"; no Stripe or database identifiers). Items 6.1–6.3 | Staging → Finance → Invoices → open any paid invoice → its receipt; open both the page and the PDF | 5 min |
| F2 | **Approve customer-notification wording**: account, purchase, invoice/receipt, appointment booked/changed, support reply, refund request, dispute, maintenance agreement, subscription activated, "subscription did not start" (new), subscription payment failed | Staging → Email operations → Templates | 10 min |
| F3 | **Review the one unexpected secret on the production Worker.** Provisioning run 42119243249 warned that `crestmont-platform-production` holds a payments, email, voice, AI or preview secret that setup never installs | Cloudflare → Workers → crestmont-platform-production → Settings → Variables and Secrets | 5 min |
| F4 | **DNS for `crestmontwebsitedevelopment.com`**: screenshot the apex records, remove any apex CNAME, set SSL/TLS to Full (strict), minimum TLS 1.2, and turn on **Always Use HTTPS** (staging's transport check warns that plain http is served without a redirect). The platform has no DNS access by design (BLK-011) | Cloudflare → the domain → DNS, SSL/TLS | 10 min |
| F5 | **Production backup destination**: set `BACKUP_S3_*` and `BACKUP_SEAL_PASSPHRASE` (docs/BACKUP-RECOVERY.md §3.2) and the repository variable `PRODUCTION_URL`. This turns on the free production health monitor and daily off-Cloudflare backup. Production backups are not verified until the first restore drill there succeeds | GitHub → Settings → Secrets and variables | 10 min |
| F6 | **Authorize the production deployment**, then the production smoke test, then the decision to open customer access | You tell me in this session | — |

At customer activation (not before): production Resend key (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`) and live
Stripe keys with `PAYMENTS_LIVE_AUTHORIZED = "yes"`. Each is a separate authorization.

## Does not block production

| # | Action | Where | Time |
|---|---|---|---|
| F7 | **Outbound voicemail AI disclosure.** The sales agent's fixed voicemail text (288 characters) names Crestmont and a callback number but never says the caller is an AI. Add it, e.g. "Hi, this is Cimo, an AI assistant calling on behalf of Crestmont Website Development…", keep the same callback number, and publish. **Do not change the prompt.** This is the only remaining failure in the live audits (receptionist 43/43, sales agent 42/44) | Retell → outbound workspace → agent `agent_bbb30864fb403d788a5a2784bc` → Call settings → Voicemail | 3 min |
| F8 | **"Adopt live prompt"** records your newly published sales prompt as the Self-Improvement Engine's baseline (writes nothing to Retell). Until you press it, the engine refuses to deploy over your prompt | Staging → /staff/sales-optimization | 1 min |
| F9 | **Counsel approval before outbound AI calling is ever enabled** (TCPA / 47 CFR 64.1200, including the voicemail opt-out mechanism). An automated audit is not legal approval. Outbound calling stays off until then | Counsel | — |
| F10 | **Visual approval of the Owner Dashboard and staff screens**, desktop and phone (walkthrough W1 in the master report: navigation, My Work, Sales, Lead Research evidence, Employees, Audit logs) | Staging, Owner sign-in | 20 min |
| F11 | **One controlled inbound call** to +1 517-300-2055 from your own phone, to approve voice and conversation quality. One call exercises consent, pricing, lead capture, AI and Founder callback booking, reschedule and cancel (walkthrough W5) | Your phone | 8 min |
| F12 | **AI draft quality.** Open the newest "Closeout" support ticket and conversation, click AI Draft Reply, and judge the tone (walkthrough W3) | Staging → Support, Conversations | 5 min |

Already done by you, so not repeated here: both Retell master prompts saved and republished (2026-11-08).
