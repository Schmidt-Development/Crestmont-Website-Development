# Website

A multi-page website served as static assets by a Cloudflare Worker.

## Run locally

```sh
npm run check -- --package starter   # offline checks: HTML, links, SEO meta, accessibility basics, responsive CSS
npx wrangler dev                      # http://localhost:8787 (static pages + the /api/contact endpoint)
```

No install step is needed for the checks (Node 22+). `wrangler dev` downloads Wrangler on first use.

## Contact form

`POST /api/contact` validates submissions but is **not connected to a mail provider yet**: it answers
"not connected" and the page asks visitors to email or call instead. Connecting a provider is a separate,
approved step; its credentials belong in Worker secrets, never in this repository.

## Deploy

Previews are deployed by Crestmont to preview resources. Production publishing, domains and DNS are handled
separately during launch.
