# CRM import API v1 (research agent and future integrations)

`POST /api/crm/v1/imports` — the one way an external engine adds businesses to the Crestmont CRM. The engine sends
candidate records; **Crestmont decides** what each one is (new, existing, shared, customer, suppressed, needs review).
The engine must not implement identity or deduplication rules of its own.

> Public business listings are **not consent** to call or email. A `CREATED` outcome never makes a number callable:
> outbound calls still need staff approval, recorded consent for the purpose, no do-not-call entry, the recipient's
> calling hours and the per-number limits (src/services/voice-outbound.ts).

## Authentication

HMAC-SHA256 over `<unix-seconds>.<exact request body>` with the environment's `CRM_IMPORT_SECRET`, sent as
`x-crestmont-signature: t=<unix-seconds>,v1=<hex>` (±10 minutes). Same scheme as the evidence and scheduler endpoints.
No cookies. Unset secret → `503`; bad or missing signature → `401`.

```js
const ts = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", process.env.CRM_IMPORT_SECRET).update(`${ts}.${body}`).digest("hex");
await fetch("https://crestmontwebsitedevelopment.com/api/crm/v1/imports", { method: "POST", body,
  headers: { "content-type": "application/json", "x-crestmont-signature": `t=${ts},v1=${sig}`,
    "idempotency-key": "2026-10-30-batch-0042" } });
```

| Header | Required | Meaning |
|---|---|---|
| `x-crestmont-signature` | yes | see above |
| `idempotency-key` | yes | 8–120 chars `[A-Za-z0-9._:-]`, unique per batch. Same key + same body → replay; same key + different body → `409` |

## Limits

| Limit | Value | Why |
|---|---|---|
| Records per request | **25** | Measured ~15 D1 statements per typical record (`scripts/bench-crm-import.ts`); worst case (10 identifiers) ~40. 25 keeps a request within D1's 1,000 queries per Worker invocation |
| Batches per hour per client | 120 (= 3,000 records/hour) | The 10,000 records/day design target needs ~400 batches/day (~17/hour) |
| Body size | 1 MB | shared API limit |

Throughput was measured **locally on SQLite** (≈350 records/s; 382 statements per full batch). D1 adds network latency
per statement; confirm real throughput on staging before scheduling large runs.

## Request

```json
{
  "apiVersion": "2026-10-30",
  "records": [
    {
      "externalId": "osm:node/1234567",
      "business": {
        "name": "Harbor Coffee",
        "website": "https://harbor.example",
        "location": {
          "city": "Ann Arbor",
          "region": "MI",
          "postalCode": "48104"
        }
      },
      "contact": {
        "name": "Morgan Reyes"
      },
      "phones": [
        {
          "value": "(734) 555-0142",
          "label": "main"
        }
      ],
      "emails": [
        {
          "value": "hello@harbor.example"
        }
      ],
      "verifiedFields": [
        "website"
      ],
      "confidence": 55,
      "interest": "business",
      "evidence": {
        "sourceUrl": "https://harbor.example/contact",
        "observedAt": "2026-10-29T14:00:00Z",
        "notes": "Hours and phone listed on the business's own site"
      }
    },
    {
      "externalId": "osm:node/7654321",
      "business": {
        "name": "Moss Landscaping",
        "website": "https://moss-landscaping.example"
      },
      "phones": [
        {
          "value": "+1 313 555 0191"
        }
      ]
    },
    {
      "externalId": "osm:node/1111111",
      "business": {
        "name": "Quiet Co"
      },
      "phones": [
        {
          "value": "313-555-0133"
        }
      ]
    },
    {
      "externalId": "osm:node/2222222",
      "business": {
        "name": ""
      },
      "phones": [
        {
          "value": "12"
        }
      ]
    }
  ]
}
```

| Field | Rules |
|---|---|
| `apiVersion` | must be `"2026-10-30"` |
| `client` | optional (default `research-agent`), 2–40 chars `[a-z0-9-]`. Inside the signed body, so it cannot be swapped on a replay. Rate limits and record keys are per client |
| `dryRun` | optional `true`: predict outcomes without writing anything |
| `records[].externalId` | required, 1–120 chars `[A-Za-z0-9._:/-]`, stable per business in your system. Record idempotency key = `<client>:<externalId>:<hash of the record>` |
| `business.name` | required, ≤160 |
| `business.website` | optional http(s) URL; its domain (+ location) is the strong business identity |
| `business.location` | optional `{city, region, postalCode}`; separates locations of one business/franchise |
| `contact.name` | optional |
| `phones[]`, `emails[]` | at least one identifier in total; ≤5 each; `label` ∈ main, mobile, office, direct, shared_line, shared_inbox, other; `verified` boolean |
| `verifiedFields` | optional subset of `contact_name`, `business_name`, `website` you have verified |
| `confidence` | optional 0–100 (capped at 60 for research data) |
| `interest` | optional: starter, business, premium, custom, maintenance, other (default other) |
| `evidence` | optional `{sourceUrl, observedAt, notes}`, kept as provenance on the lead |

Phones are normalized to E.164 (`+<digits>` kept; 10 digits → `+1`). Emails: trim + lowercase only (Gmail dots and
`+tags` are kept: they can be different mailboxes).

## Response (`200`)

Real output of the request above against a CRM that already had Moss Landscaping and a do-not-call entry:

```json
{
  "apiVersion": "2026-10-30",
  "batchId": "imp_1ae414bba026889e60c2d19c",
  "dryRun": false,
  "replayed": false,
  "received": 4,
  "counts": {
    "CREATED": 1,
    "EXISTING_BUSINESS_UPDATED": 1,
    "SUPPRESSED": 1,
    "REJECTED_INVALID": 1
  },
  "results": [
    {
      "externalId": "osm:node/1234567",
      "outcome": "CREATED",
      "decisionId": "dec_eabd27af5528aaaca9efc808",
      "leadId": "ld_dd7968a45e019e34a698de13",
      "contactId": "ct_9e2428a7a5b149a67ca6be9c",
      "replayed": false,
      "reviewIds": [],
      "suppressed": {
        "phone": false,
        "email": false
      },
      "reasons": [
        "no_match"
      ]
    },
    {
      "externalId": "osm:node/7654321",
      "outcome": "EXISTING_BUSINESS_UPDATED",
      "decisionId": "dec_dc88360b943e0509a890a7ac",
      "leadId": "ld_c1a552da3901fa4a8badd9de",
      "contactId": "ct_7b947a3d28ffd01fa17a41e5",
      "replayed": false,
      "reviewIds": [],
      "suppressed": {
        "phone": false,
        "email": false
      },
      "reasons": [
        "strong_phone_name_company_match"
      ]
    },
    {
      "externalId": "osm:node/1111111",
      "outcome": "SUPPRESSED",
      "decisionId": "dec_b9c8a2ef38e0d6a23efcdd93",
      "leadId": null,
      "contactId": null,
      "replayed": false,
      "reviewIds": [],
      "suppressed": {
        "phone": true,
        "email": false
      },
      "reasons": [
        "phone_on_do_not_call_list"
      ]
    },
    {
      "externalId": "osm:node/2222222",
      "outcome": "REJECTED_INVALID",
      "errors": [
        "business.name is required (1–160 characters)"
      ],
      "retryable": false
    }
  ]
}
```

| Outcome | Meaning | Lead created? |
|---|---|---|
| `CREATED` | New business/contact/lead. Shared identifiers are linked to the same canonical identity | yes |
| `EXISTING_CONTACT_LINKED` | Matched an existing contact/customer; evidence attached; nothing overwritten | no |
| `EXISTING_BUSINESS_UPDATED` | Matched; blank fields filled or an additional phone/email added (audited) | no |
| `VERIFIED_DATA_MERGED` | Matched; your verified value replaced an unverified automated one (audited) | no |
| `POSSIBLE_DUPLICATE_REVIEW` | Ambiguous; held in the staff review queue (`reviewIds`) | no (until a person decides) |
| `SUPPRESSED` | Phone on the do-not-call list or email suppressed; nothing created or reactivated | no |
| `REJECTED_INVALID` | Failed validation (`errors`, never echoing your values); do not retry unchanged | no |
| `NO_CHANGE` | Matched and nothing new | no |
| `ERROR` | Transient failure for this record only (`retryable: true`) | no |

Existing customers are never turned into prospects; conflicting values go to the review queue, never applied.

## Errors

| Status | When |
|---|---|
| 400 | missing/invalid `idempotency-key` or `client`, body not a JSON object |
| 401 | missing, malformed, expired or wrong signature |
| 409 | `idempotency-key` reused with a different body |
| 413 | more than 25 records |
| 422 | wrong `apiVersion`, empty `records` |
| 429 | over 120 batches/hour (`retryAfterSeconds`) |
| 503 | `CRM_IMPORT_SECRET` not configured in this environment |

## Retry rules

- Network failure or `5xx`: resend the **same body with the same `idempotency-key`**. Records already decided replay
  (`replayed: true`); only failed records are processed again.
- `ERROR` on some records: same as above.
- Splitting or re-batching records is safe: an identical record (same client, `externalId` and content) always replays
  its first decision, whatever batch it arrives in.
- Corrected data for a business: send it under the **same `externalId`**. It is a new decision that matches the
  existing record by phone/email/domain, so it updates blanks, adds identifiers, or goes to review; it never creates a
  second lead.
- Replays count toward the hourly batch limit.
