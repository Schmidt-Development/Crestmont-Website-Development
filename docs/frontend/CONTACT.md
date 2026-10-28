# Contact page and intake form

**The intake contract is unchanged:** the same fields and names (`name`, `email`, `phone`, `company`, `interest`,
`message`), the same `interest` values, the same server validation, CSRF, honeypot, per-IP rate limit (10 per hour),
Turnstile (when a site key is configured), CRM lead (`source = web_form`), acknowledgement email and thank-you
redirect. The topic select is now a group of radio chips that posts the same `interest` field.

## Design

- **The form card:** the centred focal point, organised in three steps (About you · What is it about? · Your message),
  with a live progress bar for the four required details and a message character count.
- **The workspace:** four decorative panels (website, code, care, conversation) around the card react to the chosen
  topic, to focus on the message field, and to sending. They are hidden below 1100px. With reduced motion they are
  static.
- **The official addresses** (general and support, sales, billing): shown as linked channel tiles, with staffed
  hours, the portal and the quote form beneath.
- **The thank-you page:** an animated check and "Recorded → Read by a person → Reply by email". It is shown only after
  the server has accepted the message.

## Reliability fixes

- **Duplicate submissions:** a one-time `submission` token (not stored as lead data) is consumed only after validation
  passes. A double click, a retry or a replay lands on the thank-you page without creating a second lead, and a token
  survives a validation error. If saving fails, the token is released, so the visitor can resubmit and is never told
  "received" falsely. The same guard applies to the quote form. Tested with two simultaneous identical submissions:
  exactly one lead is created.
- **Global double-submit guard (`app.js`):** it previously decided synchronously, so a submit cancelled by a later
  handler (client-side validation) left the button disabled with a spinner for 8 seconds. It now decides after all
  handlers have run.
- **Inline validation:** it mirrors the server's rules, and errors are linked to their fields with `aria-describedby`.
  An incomplete form moves focus to the first problem, and the server remains the authority.
- **Phone keyboards:** fields use the `email` and `tel` input types, and the assistant launcher hides while a form
  field has focus on a phone.
