# Email: sending domain, DNS records and mailboxes (CREST-GAP-012)

Transactional email is sent through Resend from `support@crestmontwebsitedevelopment.com` (`EMAIL_FROM`, default in
`src/app/app.ts`). Receipts cite `billing@crestmontwebsitedevelopment.com` (`src/services/receipts.ts`). Until the
domain is verified the `/staff/integrations` Resend probe reports *degraded*, and no message should be relied on.

Source for the record set: Resend's Cloudflare guide, <https://resend.com/docs/guides/dns/cloudflare> (checked
2026-10-29). **Always copy the exact values from the domain's page in the Resend dashboard** — the server names and
DKIM key are specific to the domain and region.

## 1. Add the domain in Resend

Resend → Domains → Add domain → `crestmontwebsitedevelopment.com` (or a sending subdomain such as `mail.` — Resend
recommends a subdomain when the root already receives mail; then set `EMAIL_FROM` to that subdomain's address).

## 2. Records in Cloudflare DNS (zone `crestmontwebsitedevelopment.com`)

| Type | Name | Value | Priority | Proxy |
| --- | --- | --- | --- | --- |
| MX | `send` | the feedback SMTP host shown by Resend (e.g. `feedback-smtp.us-east-1.amazonaws.com`) | 10 (use an unused priority) | — |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` (as shown by Resend) | — | — |
| TXT | `resend._domainkey` | the `p=…` DKIM public key shown by Resend | — | **DNS only** |
| TXT | `_dmarc` | start with `v=DMARC1; p=none; rua=mailto:dmarc@crestmontwebsitedevelopment.com`, move to `p=quarantine` after two clean weeks of reports | — | — |

Enter only the host part (`send`, `resend._domainkey`, `_dmarc`) — not the full domain. If Cloudflare answers
"Code: 1004", the record was proxied; set it to DNS only. Receiving through Resend (an `inbound` MX) is **not** used:
mailboxes live with the mail host below.

Then Resend → Domains → the domain → **Verify DNS records** (can take up to 72 hours).

## 3. Mailboxes (IDENT-003)

Create at the chosen mail host (its own MX records on the root domain): `support@`, `billing@`, `sales@`, `legal@`
(and `dmarc@` for reports, or point `rua` at a reporting service). Replies to platform email go to `support@`.

## 4. Keys and webhooks per environment

| Item | Staging | Production |
| --- | --- | --- |
| API key | Resend → API Keys → *Sending access*, restricted to the domain → `wrangler secret put RESEND_API_KEY --env staging` | a **separate** key → `--env production` |
| Webhook | Resend → Webhooks → `https://<staging host>/api/webhooks/resend`, events `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`, `email.suppressed` → signing secret → `RESEND_WEBHOOK_SECRET` | same with the production host and its own secret |
| Recipients | `EMAIL_RECIPIENT_ALLOWLIST` (default `@crestmontwebsitedevelopment.com`) — staging mails nobody else | unrestricted |

## 5. Verify

1. `/staff/integrations` → Resend → *Verify*: expects **verified** (the probe lists the domain and requires status `verified`).
2. Send one platform email to an external Gmail address (production) or an allowlisted address (staging), open
   *Show original*: `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
3. Watch `/staff/email` for the `delivered` webhook status on that message.
