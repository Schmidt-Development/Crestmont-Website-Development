# Website

This is a full-stack business website: static pages in `public/`, a Cloudflare Worker backend in `src/`, its own D1 database in `migrations/`, and an administration area at `/admin/`.

- **Configuration:** `business.config.json`.
- **Checks:** run `npm run check` for the offline acceptance gates and `npm test` for the tests.
- **Deployment and rollback:** see `DEPLOY.md`.
- **How the site is built on the starter:** see `STARTER.md`.
