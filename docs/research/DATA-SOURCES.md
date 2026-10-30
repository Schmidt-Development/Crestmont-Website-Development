# Lead research — data sources, licences and permitted use

Checked on **2026-10-30** against the publishers' own pages. This is an engineering summary, **not legal advice**. Before production use, counsel should confirm it, together with the outbound-calling questions in `COMPLIANCE-GATE.md`. The platform's register (`research_sources`, migration 0048) records the same facts. A source that is off there is refused at ingest, even if a worker still has it configured.

| Source | Role | Licence | Commercial use | Access | Status |
|---|---|---|---|---|---|
| Overture Maps — Places | Primary business records | Per row: CDLA-Permissive-2.0; Apache-2.0 for Foursquare-sourced rows; CC0-1.0 for AllThePlaces rows | Yes | Public S3/Azure bucket, no account. GeoParquet, monthly releases (latest seen: `2026-10-21.0`) | **On** |
| Foursquare OS Places | Secondary records | Apache-2.0 (keep the NOTICE.txt and attribution) | Yes | Since Oct 2025: Places-portal account + token (Iceberg), Snowflake, or a gated Hugging Face form | **Off — Founder decision** |
| OpenStreetMap via Geofabrik | Additional records | ODbL-1.0, "© OpenStreetMap contributors" | Yes, with share-alike on Public Use | Daily `.osm.pbf` state extracts; download only what you need | **Off — Founder decision** |
| Common Crawl | Website-discovery evidence only | Common Crawl Terms of Use | Analysis yes; no republishing of crawl content, no reselling access | `data.commoncrawl.org` (HTTPS). CDX API heavily rate-limited; columnar Parquet index preferred | **On** (throttled, cached, daily cap) |
| Data.gov / state portals | Optional identity enrichment | Varies per dataset | Per dataset | Per dataset | **Off** — no dataset reviewed yet |

## What each one means for us

**Overture.** We keep the per-row licence in each prospect's provenance (`sources_json`). If Crestmont ever redistributes these records outside the company (for example, exports them to a third party), it must include the licence text and attribution ("Overture Maps Foundation, overturemaps.org"). For Foursquare-sourced rows it must also include Foursquare's NOTICE. Using them internally in the CRM needs nothing more.

Open question, flagged and not assumed: an Overture GitHub discussion (#564) asks which licence covers Overture-generated fields such as the GERS id and confidence. No answer had been published by our check date. We store those fields only for matching and provenance.

**Foursquare OS Places.** The licence is permissive, but current releases need registration. The Hugging Face gate also asks the registrant to let Foursquare use the company's name and logo in its marketing. That is a business decision, not an engineering one.

About 3.76 million Foursquare-sourced places already arrive inside Overture under Apache-2.0, so most of the value is available without this step. To enable it: the Founder registers, downloads the Parquet, sets `FOURSQUARE_PARQUET_GLOB` on the worker, and switches the source on in `research_sources`. Switching it on is a reviewed SQL change; there is no UI for it on purpose.

**OpenStreetMap.** Using OSM data only inside Crestmont triggers no obligations. Combining OSM with other data creates a Derivative Database. Making that database, or a Produced Work from it, available outside the organization ("Public Use") requires offering the OSM-derived data under ODbL. CRM use by Crestmont staff is internal.

The source stays off until the Founder confirms that OSM-derived records will never be exported or shared, for example in a lead list sent to a partner. The worker never downloads extracts by itself: the operator places the needed `<state>-latest.osm.pbf` files.

**Common Crawl.** We use it only to answer: was this candidate domain captured in a recent crawl, and with what status? We never fetch or store page content (WARC). We never republish anything from it, and we never infer a domain from a business name.

Their FAQ says the CDX index server is heavily rate-limited, that a 503 means slow down, and that a blocked IP should wait 24 hours. So the worker:
- queries the columnar index instead,
- batches up to 50 domains per query,
- waits at least 60 seconds between queries,
- caps the day at 200 queries,
- backs off ten-fold after any failure,
- caches every answer per domain and crawl.

## Sources (as checked)
- Overture places guide and per-source licence table: https://docs.overturemaps.org/guides/places/
- Overture attribution page: https://docs.overturemaps.org/attribution/
- AWS Open Data registry entry (bucket, no account): https://registry.opendata.aws/overture/
- Overture licensing question (open): https://github.com/orgs/OvertureMaps/discussions/564
- Foursquare OS Places NOTICE: https://opensource.foursquare.com/places-notice-txt/
- Foursquare access change (portal/token, Oct 2025): https://foursquare.com/resources/blog/data/evolving-fsq-open-source-places/
- Hugging Face gated dataset card: https://huggingface.co/datasets/foursquare/fsq-os-places/blob/main/README.md
- OSMF licence FAQ (Public Use, Derivative Database, Produced Work): https://osmfoundation.org/wiki/Licence_and_Legal_FAQ
- Geofabrik US extracts: https://download.geofabrik.de/north-america/us.html. The page itself could not be fetched from the build session. Daily updates are confirmed by the OSM help archive; the operator should read Geofabrik's current usage notes before the first download.
- Common Crawl FAQ (CDX rate limiting, 503 handling): https://commoncrawl.org/faq
- Common Crawl infrastructure status and retry guidance: https://status.commoncrawl.org/
