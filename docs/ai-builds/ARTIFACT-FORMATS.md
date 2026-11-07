# The supported frontend artifact contract

What Crestmont accepts when an owner uploads a finished frontend, what it does with it, and what it refuses. One
place, because the absence of this document is what allowed the code to refuse an artifact with a message listing
that artifact's own format as supported.

The decisions live in `runner/src/frontend/artifact.ts` (the verdict, reached from the archive listing before
anything is written to disk) and `runner/src/frontend/ingest.ts` (the scanning gate, extraction, entry point).
`runner/test/frontend-artifact.test.ts` and `runner/test/frontend-ingest.test.ts` are the executable form of this
page; where they and this page disagree, they are right and this page is stale.

## The package

A **ZIP archive**. Nothing else is read.

The archive's own top folder is stripped when every entry shares one, so a ZIP made by right-clicking a project
folder (`my-site/index.html`, `my-site/styles.css`) is treated as if its contents were at the top. Archiver noise
(`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `.AppleDouble/`) is ignored.

## Which document the website opens at

Decided by `discoverHtmlEntry`, in this order. It is the only place that decides it.

| the archive holds | entry point | result |
|---|---|---|
| an `index.html` (or `.htm`) at the top level | that file | accepted; the ordinary case, and it always wins |
| exactly one `index.html`, deeper in (`dist/`, `build/`, `site/`) | that file | accepted; the build serves that folder |
| exactly **one** HTML document, named anything | that file | accepted, and **renamed to `index.html`** (see below) |
| several HTML documents and no `index.html` | — | **refused**: `ambiguous-entry-point`, naming the candidates |
| no HTML and no `package.json` | — | refused: `unsupported-framework` |

**Entry-point normalisation.** A website opens at `/`. A single document called `01-vesper-rowe-law.html` is a
complete website, but served as it stands it has no root document at all: a visitor who types the address gets
nothing. So an unambiguous single-document archive has that file **renamed** to `index.html` beside itself, and the
import record says so (`entry-point-normalised`, visible on the project page). Renamed rather than copied: two
identical documents would be measured as two pages, and the approved design would carry a page that does not exist.

Only the unambiguous case. An archive with an `index.html` is left exactly as it is, and one with several
documents and no index is refused with its candidates named. Nothing picks a file on an owner's behalf.

## Supported project kinds

| kind | recognised by | build |
|---|---|---|
| `static` | HTML present and no React/Vite signals | no install, no build; served as uploaded |
| `vite` | `vite` dependency or `vite.config.{js,ts}` | `npm ci` then `npm run build` |
| `react` | `react` dependency, or `.jsx` sources | `npm ci` then the package's build script |
| `react-ts` | as React, plus `.ts`/`.tsx` or a `tsconfig.json` | as React |

A `vite`, `react` or `react-ts` project **must** carry a `package.json`; a static site must not need one. A
non-static project with no lockfile is a warning, not a refusal: the build cannot then be reproduced exactly.

## Supported content

Accepted and exercised by tests or real uploads: a single self-contained document (CSS and JavaScript inline);
arbitrarily named single entry points; `index.html` projects; separate CSS and JavaScript files; local images and
fonts; a top-level folder inside the ZIP; several HTML pages where one of them is `index.html`; client-side
JavaScript interactions; relative and absolute asset references; compiled framework output (`dist/`).

**External images, fonts and stylesheets are acquired once and pinned.** The measurement runs in a container with
`--network none`, so nothing can be fetched while a design is being measured — and it must not be, or the
approved design would be whatever a CDN served that minute. So the dependencies are resolved at ingestion
instead, by the platform (`src/services/artifact-assets.ts`), written into the artifact under
`_crestmont-assets/<content-hash>.<ext>`, and the references rewritten to point at them. The measurement, the
approved baseline, Model B's build and the final visual verification then all render the same bytes, and none of
them fetches anything. Resolution happens on the platform because Node 1 cannot: its egress proxy allows the npm
registry, the control plane and the model server, and explicitly denies the domain Google Fonts is served from.

Two rounds, because a font-CDN stylesheet names the font files rather than containing them: the document's
references are resolved first, then the references inside any stylesheet that was just pinned. A chain deeper
than that is not a website's typography and is not followed.

The rules, all in one place and applied at every redirect hop:

| rule | why |
|---|---|
| `https` only, port 443, no credentials in the URL | an upload must not be able to name a scheme or a secret |
| no IP-literal host; no private, loopback, link-local or `.internal` name | an uploaded file must not be able to address the inside of anything |
| redirects followed at most 3 times, each hop re-checked | a public URL that redirects inward is the attack this stops |
| an allow-list of content types, each confirmed against the bytes' own magic numbers | a `Content-Type` is a claim by a stranger |
| 8 MB per asset, 64 MB and 120 assets per artifact | an artifact is a website, not a crawl |
| scripts are never fetched | pinning somebody's bundle means running code we downloaded |

**A dependency that cannot be acquired blocks approval.** It is recorded with the reason and with what its absence
does to the page — "the typeface served by fonts.gstatic.com is not available, so this text renders in a fallback
font" — shown on the project page, and `approveBaseline` refuses while any remain. The remedy is to package the
asset in the archive or make it publicly readable, not to approve around it. A remote **script** is reported the
same way but does not block: anything it draws after load is simply not part of the measured design.

## Refused, and why

Security refusals are never relaxed to support a format:

| code | what it stops |
|---|---|
| `unsafe-path` | `../` escapes and absolute paths, caught in the listing and again at write time |
| `symlink` | a link inside an artifact has no legitimate use and every illegitimate one |
| `executable-payload` | `.exe`, `.so`, `.sh`, `.wasm` and the rest; a frontend is not a binary drop |
| `embedded-credential` | a committed API key or token, named by type and never echoed |
| `unvetted-dependency` | a dependency resolving to git/http/file instead of the registry |
| `expansion-ratio`, `archive-too-large`, `file-too-large` | decompression bombs and oversized archives |
| `unreadable-archive` | not a ZIP, or structurally broken |
| `scan-required`, `scan-failed`, `scan-infected` | no clean malware verdict; a customer upload is never unpacked without one |

Format refusals, which an owner can act on:

| code | what to do |
|---|---|
| `ambiguous-entry-point` | add an `index.html` at the top level, or upload a single document on its own |
| `unsupported-framework` | the archive holds no HTML and no `package.json` |
| `missing-package-json` | a React or Vite project needs its manifest |
| `invalid-package-json` | the manifest is not valid JSON |
| `empty-archive` | nothing in it |

## Recovering a refused artifact

A rejected artifact's archive stays in R2 with its scan verdict. **Import again** on the project page
(`DL.retryImport`) offers it to the importer a second time — after re-reading the scan status from `files`, so a
retry can never bypass scanning. Only the project's latest rejected artifact can be retried; a quarantined archive
is replaced by a person, not retried. This exists because a wrong verdict used to be permanent: the claim only
offers `received` artifacts, so every artifact refused before a fix to the importer stayed refused.

## Not supported

Anything that is not a ZIP. Server-rendered frameworks that need a runtime of their own (Next.js SSR, Nuxt,
SvelteKit with an adapter, Astro SSR): the builder serves static output and adds a backend behind it, so a project
that needs its own server is out of scope rather than quietly half-built. Several HTML documents with no
`index.html`. Assets that are not publicly readable: the platform does not authenticate to a third party on an
owner's behalf, so an asset behind a login or a signed URL is reported as missing and blocks approval.
