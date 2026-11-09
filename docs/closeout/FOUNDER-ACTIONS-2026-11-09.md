# Founder-only actions (updated 2026-11-09)

Everything engineering-controlled is finished and verified on staging; see
[MASTER-VERIFICATION-2026-11-08.md](MASTER-VERIFICATION-2026-11-08.md) for the evidence behind each of the 112 items.
This list holds only what needs your judgment, your accounts or your authorization. Nothing below asks you to read code,
run SQL, operate CI or inspect webhooks.

Staging: `https://crestmont-platform-staging.partners-df4.workers.dev`. Use the Owner sign-in from the sealed access
notes of the latest staging deploy.

## Done by you

- **F1** Invoice and receipt appearance: approved.
- **F4** Domain DNS and HTTPS: configured.
- Both Retell master prompts saved and republished (2026-11-08).

## Blocks production

### F2: approve the customer email wording (about 15 minutes)

1. Sign in to staging as the Owner and open **`/staff/email/templates`** (Email operations → **Template review**).
2. The "What to review" table at the top maps your twelve notification types to the actual templates. Click each one;
   every variant shows the real email at desktop and phone width, its subject, sender and plain-text version. Nothing
   on this page sends email.
3. Wording changed on 2026-11-09 and worth a closer look:
   - **"Two steps before your website goes live"**: asks the customer to sign the maintenance agreement, then activate
     the subscription. It replaces an awkward pasted-status subject.
   - **"Your website hosting is restored"**: replaces the generic status message.
   - **"Your maintenance subscription did not start"**: sent when the first payment is declined.
   - Support confirmations now quote a short reference such as **S-3F9A2C7B** instead of a database id.
4. One decision is yours: there is **no separate "agreement signed" email** today (signing is confirmed on screen and
   recorded). Say if you want one.
5. Tell me "F2 approved", or which wording to change.

The footer of every email shows "Registered business address pending" and "Contact email pending" until those are
recorded in **Business settings**. Fill them in there if you want them in the emails.

### F3: production Worker secrets — resolved, nothing to delete

The provisioning warning matched **`STRIPE_SECRET_KEY`** and **`RESEND_API_KEY`**, which you installed (together with
`STRIPE_WEBHOOK_SECRET`, `RESEND_WEBHOOK_SECRET` and `STRIPE_PUBLISHABLE_KEY`). They are the payment and email credentials
production needs at customer activation, so they stay. They cannot start charging: production refuses every Stripe key
and event until you add the plain variable `PAYMENTS_LIVE_AUTHORIZED = yes`. All required production secrets are present
(Turnstile ×2, evidence ingestion, MFA encryption, CRM erasure).

Engineering fix made: the first production deploy would have **deleted any plain-text variable you set in the
Cloudflare dashboard** (it happened to `STRIPE_PUBLISHABLE_KEY` on staging on 2026-10-31). The production deploy now
keeps them and proves it before and after deploying.

No action required. Optional confirmation, done together with F5 step 4.

### F5: production backups (about 15 minutes)

`PRODUCTION_URL` is already set (`https://crestmontwebsitedevelopment.com`); monitoring and backups start by themselves
after the first production deploy. What is missing is **where backups go** and **the key that encrypts them**.

1. **Create a free Backblaze B2 account and bucket** (first 10 GB always free; checked 2026-11-09).
   - Bucket name, for example `crestmont-backups-production`, **Private**, Object Lock or versioning on.
   - Lifecycle rule: **keep 14 days** of files.
   - B2 → **Caps & Alerts**: set every cap to **$0**, so B2 refuses rather than bills.
   - Create an **application key limited to that one bucket**. Note its keyID, applicationKey, and the bucket's S3
     endpoint (shown on the bucket page, like `https://s3.us-west-004.backblazeb2.com`).
2. **Create the encryption passphrase**: a random phrase of 32+ characters. Save it in your password manager first:
   without it no backup can be opened.
3. **Add them to GitHub**: repository → Settings → Environments → **production** → Environment secrets:
   `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID` (keyID), `BACKUP_S3_SECRET_ACCESS_KEY`
   (applicationKey), `BACKUP_SEAL_PASSPHRASE`. Do not paste any of them into chat.
4. **Prove it**: Actions → **Production readiness check (read-only)** → Run workflow, then approve it when GitHub asks.
   It confirms the production secret names, D1 and R2, and round-trips an encrypted test file through B2 (no customer
   data). Tell me when it has run.
5. Decide whether daily backups may run without your approval each morning. If yes, create a second environment (for
   example `production-backup`) holding the same secrets, without required reviewers, and set the repository variable
   `BACKUP_ENVIRONMENT` to its name. If no, approve the backup run each day.

A real production backup and restore can only be proven after the first production deploy; the daily backup job
restores every backup into a scratch database and compares every table automatically.

### F6: authorize the production deployment

Then the production smoke test, then the decision to open customer access.

## Does not block production

| # | Action | Where |
|---|---|---|
| F7 | **Outbound voicemail AI disclosure.** Add "an AI assistant" to the sales agent's fixed voicemail text, keep the callback number, publish. Do not change the prompt | Retell → outbound workspace → agent `agent_bbb30864fb403d788a5a2784bc` → Call settings → Voicemail |
| F8 | **"Adopt live prompt"**: records your published sales prompt as the Self-Improvement Engine's baseline | Staging → /staff/sales-optimization |
| F9 | **Counsel approval before outbound AI calling is ever enabled** | Counsel |
| F10 | **Visual approval of the Owner Dashboard and staff screens** (desktop and phone) | Staging, Owner sign-in |
| F11 | **One controlled inbound call** to +1 517-300-2055 for voice quality and live calendar booking | Your phone |
| F12 | **AI draft tone**: open the newest "Closeout" support ticket and conversation, click AI Draft Reply | Staging → Support, Conversations |
