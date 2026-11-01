# Deployment and rollback

This website runs as one Cloudflare Worker (static pages from `public/` plus the `/api/*` backend) with its **own** D1 database. Staging previews are deployed by Crestmont's runner. A production deployment needs the Owner's explicit authorization in the Crestmont platform. Production runs on the **customer's** Cloudflare account.

## First deployment (customer account)

1. Create the database with `wrangler d1 create <site>-db`, then put its id into `wrangler.jsonc` (`d1_databases[0].database_id`).
2. Apply the migrations: `wrangler d1 migrations apply <site>-db --remote`.
3. Add the secrets with `wrangler secret put <NAME>`. They go on the customer's account, never in the repository.
   - `ADMIN_SETUP_TOKEN`: a random string of at least 24 characters. Use it once to create the owner account, then delete it.
   - If payments are enabled: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Use the customer's own Stripe account: test keys on staging, live keys only in production, and only after `PAYMENTS_LIVE_AUTHORIZED=true` has been authorized.
   - If email is enabled: `RESEND_API_KEY` and `MAIL_FROM`, from the customer's own Resend account with a verified sending domain.
4. If payments are enabled, add a Stripe webhook endpoint for `https://<domain>/api/webhooks/stripe` with these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `charge.refunded`
5. Deploy with `wrangler deploy`.
6. Check that `GET /api/health` answers `{ "ok": true }`.

## Updates

- **Schema changes are new numbered files** in `migrations/` (`0002_…`, …). Never edit a migration that has already been applied. Apply them before deploying the code that needs them.
- **Changes must be backward compatible for one release.** Add columns and tables first, and remove old ones in a later release, so that a rollback of the code never meets a schema it cannot read.

## Backups and rollback

**Before every production migration**, export the database: `wrangler d1 export <site>-db --remote --output backup-<date>.sql`. D1 Time Travel can also restore the database to any minute in the last 30 days: `wrangler d1 time-travel restore <site>-db --timestamp <ISO time>`.

**To roll back the code**, use `wrangler rollback`, or redeploy the previous Git tag. Migrations are forward-only and additive, so the previous code still works with the newer schema.

**To roll back the data**, restore with Time Travel to the timestamp before the faulty change. Then reconcile payments from Stripe: the admin "Check with Stripe" action, or webhook re-delivery from the Stripe dashboard.

**After any rollback**, check `GET /api/health`, make a test booking, and send a test contact message on staging.
