// AI Receptionist demonstrations (docs/frontend/AI-RECEPTIONIST.md): the call "control centre" used on the homepage and
// the service page, and the voice-style library. Everything is a labelled simulation: a fictional business, synthetic
// callers on fictional 555-01xx numbers, no audio, no real call, no network request. public/assets/services.js
// (engines "receptionist" and "voices") plays the conversation; without JavaScript every line and the final state
// of each connected system are readable as written.
import { html, type SafeHtml } from "../lib/html.ts";

type Who = "ai" | "caller" | "system";
/** One step of a scripted call. `effect` names a connected-system update (data-effect) applied when the line plays. */
interface Line { who: Who; text: string; effect?: string; note?: string }
interface Scenario { key: string; label: string; mode: "inbound" | "outbound"; caller: string; number: string; intro: string; checks?: string[]; lines: Line[]; summary: [string, string][] }

const BIZ = "Northfield Renovation";
export const RECEPTIONIST_SCENARIOS: Scenario[] = [
  {
    key: "book", label: "Book an estimate", mode: "inbound", caller: "Jordan Ellis", number: "(517) 555-0142",
    intro: "A new customer calls after hours to arrange an estimate visit.",
    lines: [
      { who: "system", text: "Incoming call · after hours · answered on the first ring", effect: "call:connected" },
      { who: "ai", text: `Hi, thanks for calling ${BIZ}. I'm the AI assistant — I can answer questions and book visits. This call may be recorded so we can follow up; is that all right?` },
      { who: "caller", text: "Sure, that's fine. I'm hoping to get someone out to look at a bathroom remodel." },
      { who: "ai", text: "Happy to help with that. Is this for a full remodel, or mainly the shower and tile?", note: "Asks a follow-up instead of reading a script" },
      { who: "caller", text: "Full remodel. It's a small upstairs bathroom — oh, and we have a dog, so whoever comes should know." },
      { who: "ai", text: "Noted — a small upstairs bathroom, full remodel, and a dog at home. I have Tuesday at 9 or Thursday at 10 for an estimate visit—", effect: "calendar=Checking availability…", note: "Remembers details from earlier in the call" },
      { who: "caller", text: "Thursday at 10 works.", note: "Caller interrupts; the assistant stops and listens" },
      { who: "ai", text: "Thursday at 10 it is. Can I take your name and the best number for a text confirmation?", effect: "calendar=Booked · Thursday 10:00" },
      { who: "caller", text: "Jordan Ellis, and this number is fine." },
      { who: "ai", text: "Thanks, Jordan. You're booked for Thursday at 10 — I've sent a confirmation by text, and the team will see your note about the dog. Anything else?", effect: "crm=New lead · Jordan Ellis · remodel;confirm=Text confirmation sent" },
      { who: "caller", text: "No, that's everything. Thanks!" },
      { who: "system", text: "Call completed · summary filed", effect: "call:ended;summary" },
    ],
    summary: [["Outcome", "Estimate visit booked"], ["When", "Thursday 10:00"], ["Caller", "Jordan Ellis · (517) 555-0142"], ["Request", "Full remodel, small upstairs bathroom"], ["Notes", "Dog at home — tell the visiting team"], ["Follow-up", "Text confirmation sent; reminder the day before"]],
  },
  {
    key: "urgent", label: "Urgent → a person", mode: "inbound", caller: "Dana Morales", number: "(517) 555-0187",
    intro: "An existing customer calls about a leak. The assistant recognises the urgency and hands over.",
    lines: [
      { who: "system", text: "Incoming call · business hours", effect: "call:connected" },
      { who: "ai", text: `Hi, you've reached ${BIZ}. I'm the AI assistant. How can I help today?` },
      { who: "caller", text: "Hi — you finished our kitchen last week and there's water coming from under the sink. It's spreading." },
      { who: "ai", text: "I'm sorry — that's urgent, so I'm going to get a person on the line right now. While I connect you, is the water turned off under the sink?", effect: "handoff=Urgent · connecting a person…", note: "Recognises an urgent request" },
      { who: "caller", text: "Yes, I just shut the valve." },
      { who: "ai", text: "Good. I'm transferring you to Sam on our team and passing along everything you've told me, so you won't have to repeat it.", effect: "handoff=Transferring to Sam (on-call)…" },
      { who: "system", text: "Warm transfer to Sam (on-call) · call summary delivered with the transfer", effect: "handoff=Sam connected · summary delivered;crm=Note added to Dana Morales" },
      { who: "system", text: "Call completed · transferred to a person", effect: "call:ended;summary" },
    ],
    summary: [["Outcome", "Transferred to a person (urgent)"], ["Customer", "Dana Morales · (517) 555-0187"], ["Issue", "Leak under the sink after last week's kitchen work"], ["Done during the call", "Water shut off at the valve"], ["Handled by", "Sam, on-call, with the call summary"]],
  },
  {
    key: "confirm", label: "Appointment confirmation", mode: "outbound", caller: "Priya Shah", number: "(517) 555-0163",
    intro: "A follow-up call to a customer who asked to be contacted about their visit.",
    checks: ["Consent on file — asked for appointment calls", "Not on a do-not-call or suppression list", "Within permitted calling hours · 10:05 local time", "Purpose: appointment confirmation"],
    lines: [
      { who: "system", text: "Pre-call checks passed · placing the simulated call", effect: "checks;call:dialing" },
      { who: "system", text: "Answered", effect: "call:connected" },
      { who: "ai", text: `Hi, is this Priya? This is the AI assistant calling on behalf of ${BIZ} about your estimate visit on Thursday.` },
      { who: "caller", text: "Yes, this is Priya." },
      { who: "ai", text: "Great. You're booked for Thursday at 2. Does that still work?" },
      { who: "caller", text: "Mostly — do I need to clear anything out of the kitchen before you come?", note: "Customer asks a question" },
      { who: "ai", text: "No need for the visit itself — the team just needs to see the space and measure. Clearing the counters helps, but it isn't required.", note: "Answers from the approved information" },
      { who: "caller", text: "Okay. Actually, could we do 3 instead of 2?" },
      { who: "ai", text: "3 o'clock on Thursday is open — I've moved you to 3, and you'll get a text confirming the new time.", effect: "calendar=Moved · Thursday 15:00;confirm=Text with the new time sent" },
      { who: "caller", text: "Perfect, thank you." },
      { who: "ai", text: "You're welcome. If you'd rather not get calls like this, just say so any time." },
      { who: "system", text: "Call completed · outcome and next action recorded", effect: "crm=Outcome logged · next: reminder text;call:ended;summary" },
    ],
    summary: [["Outcome", "Confirmed and rescheduled"], ["New time", "Thursday 15:00"], ["Contact", "Priya Shah · (517) 555-0163"], ["Question answered", "No need to clear the kitchen"], ["Next action", "Reminder text the day before"]],
  },
];

const WAVE = html`<span class="rc-wave" aria-hidden="true">${Array.from({ length: 18 }, (_, i) => html`<i style="${`--i:${i}`}"></i>`)}</span>`;

/** The call control centre. `compact` is the homepage version (same engine, fewer explanations). */
export function receptionistConsole(opts: { compact?: boolean; id?: string } = {}): SafeHtml {
  const id = opts.id ?? "rc";
  const first = RECEPTIONIST_SCENARIOS[0];
  const scenario = (s: Scenario, i: number) => html`<section class="rc-scn" data-scn="${s.key}" data-mode="${s.mode}" data-caller="${s.caller}" data-number="${s.number}"${i === 0 ? html` data-on` : ""} aria-label="${`${s.label} (${s.mode})`}">
<p class="rc-scn__intro">${s.intro}</p>
${s.checks ? html`<ul class="rc-checks" aria-label="Checks before an outbound call">${s.checks.map((c) => html`<li data-check>${c}</li>`)}</ul>` : ""}
<ol class="rc-log" data-log>${s.lines.map((l) => html`<li class="rc-line rc-line--${l.who}" data-who="${l.who}"${l.effect ? html` data-effect="${l.effect}"` : ""}><span class="rc-line__who">${l.who === "ai" ? "AI receptionist" : l.who === "caller" ? (s.mode === "outbound" ? "Customer" : "Caller") : "System"}</span><span class="rc-line__text">${l.text}</span>${l.note ? html`<span class="rc-line__note">${l.note}</span>` : ""}</li>`)}</ol>
<dl class="rc-summary" data-summary>${s.summary.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
</section>`;
  const body = html`<div class="rc" data-scenario="${first.key}" data-mode="${first.mode}" data-state="idle">
<div class="rc__modes" role="group" aria-label="Call direction"><button type="button" class="rc__mode" data-mode-btn="inbound" aria-pressed="true">Inbound</button><button type="button" class="rc__mode" data-mode-btn="outbound" aria-pressed="false">Outbound</button></div>
<div class="rc__scns" role="group" aria-label="Scenario">${RECEPTIONIST_SCENARIOS.map((s, i) => html`<button type="button" class="sv__opt sv__opt--sm rc__scn-btn" data-scn-btn="${s.key}" data-mode="${s.mode}" aria-pressed="${i === 0 ? "true" : "false"}"${s.mode !== first.mode ? html` hidden` : ""}>${s.label}</button>`)}</div>
<div class="rc__grid">
  <div class="rc__call" aria-label="Call">
    <div class="rc__caller"><span class="rc__avatar" aria-hidden="true"></span><span><strong data-caller>${first.caller}</strong><span class="rc__num" data-number>${first.number}</span></span></div>
    <p class="rc__state" data-call-state>Ready — press Play to start the simulated call</p>
    <div class="rc__voice"><span class="rc__speaker" data-speaker>—</span>${WAVE}</div>
    <p class="rc__timer" data-timer aria-hidden="true">00:00</p>
  </div>
  <div class="rc__talk"><div class="rc__scroll" data-scroll>${RECEPTIONIST_SCENARIOS.map(scenario)}</div></div>
  <div class="rc__systems" aria-label="Connected systems">
    <div class="rc-sys" data-sys="calendar"><span class="rc-sys__name">Calendar</span><span class="rc-sys__val" data-sys-val>Waiting</span></div>
    <div class="rc-sys" data-sys="crm"><span class="rc-sys__name">CRM</span><span class="rc-sys__val" data-sys-val>Waiting</span></div>
    <div class="rc-sys" data-sys="confirm"><span class="rc-sys__name">Confirmation</span><span class="rc-sys__val" data-sys-val>Waiting</span></div>
    <div class="rc-sys" data-sys="handoff"><span class="rc-sys__name">Your team</span><span class="rc-sys__val" data-sys-val>On standby</span></div>
  </div>
</div></div>`;
  return html`<figure class="sv sv--receptionist${opts.compact ? " sv--compact" : ""}" data-sv="receptionist" id="sv-${id}" aria-labelledby="sv-${id}-t">
<figcaption class="sv__head"><span class="sv__tag">Simulated call · no real call, no audio</span><span class="sv__title" id="sv-${id}-t">AI receptionist control centre</span></figcaption>
<div class="sv__body">${body}</div>
<div class="sv__controls" role="group" aria-label="Call playback"><button type="button" class="sv__opt sv__opt--gold" data-play>Play call</button><button type="button" class="sv__opt" data-step>Next line</button><button type="button" class="sv__opt sv__opt--quiet" data-reset>Replay</button></div>
<p class="sv__hint">${opts.compact ? "A fictional business and callers. Switch between inbound and outbound and follow the calendar, CRM and team updates." : "A fictional business and callers on fictional numbers. Every step is shown as text, so the demonstration works without sound. Play runs the call; Next line steps through it at your own pace."}</p>
<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}

/** Voice styles. Provider voices are chosen with you during setup; nothing here claims a specific vendor voice. */
export const VOICE_STYLES: { key: string; name: string; traits: string[]; line: string; suits: string }[] = [
  { key: "warm", name: "Warm and welcoming", traits: ["Unhurried", "Friendly", "Reassuring close"], line: "Hi there — thanks so much for calling. What can I help you with today?", suits: "Home services, family businesses, clinics' front desks" },
  { key: "polished", name: "Professional and polished", traits: ["Precise", "Measured pace", "Formal greeting"], line: "Good afternoon, you've reached the front desk. How may I direct your call?", suits: "Professional offices, B2B services" },
  { key: "conversational", name: "Friendly and conversational", traits: ["Casual phrasing", "Quick back-and-forth", "Light humour"], line: "Hey, thanks for calling! Are you looking to book something, or just have a question?", suits: "Studios, salons, local shops" },
  { key: "calm", name: "Calm and reassuring", traits: ["Slower pace", "Steady tone", "Plenty of confirmation"], line: "I understand. Let's take it one step at a time — first, is everyone safe?", suits: "Repairs, emergencies, sensitive enquiries" },
  { key: "energetic", name: "Energetic and engaging", traits: ["Upbeat", "Brisk pace", "Enthusiastic close"], line: "Great to hear from you! We've got a few openings this week — want me to grab one?", suits: "Events, fitness, promotions to opted-in customers" },
];

export function voiceLibrary(): SafeHtml {
  const v0 = VOICE_STYLES[0];
  return html`<figure class="sv sv--voices" data-sv="voices" id="sv-voices" aria-labelledby="sv-voices-t">
<figcaption class="sv__head"><span class="sv__tag">Voice styles · text preview</span><span class="sv__title" id="sv-voices-t">Choose how your receptionist sounds</span></figcaption>
<div class="sv__body"><div class="vl" data-voice="${v0.key}">
<div class="vl__list" role="radiogroup" aria-label="Voice style">${VOICE_STYLES.map((v, i) => html`<button type="button" class="vl__item" role="radio" aria-checked="${i === 0 ? "true" : "false"}" tabindex="${i === 0 ? "0" : "-1"}" data-voice-btn="${v.key}"><span class="vl__name">${v.name}</span><span class="vl__traits">${v.traits.join(" · ")}</span></button>`)}</div>
<div class="vl__preview">${VOICE_STYLES.map((v, i) => html`<div class="vl__card" data-voice-card="${v.key}"${i === 0 ? html` data-on` : ""}>
<div class="vl__head"><span class="vl__badge">${v.name}</span>${WAVE}</div>
<p class="vl__line">“${v.line}”</p>
<dl class="vl__meta"><dt>Pace and tone</dt><dd>${v.traits.join(", ")}</dd><dt>Often suits</dt><dd>${v.suits}</dd></dl></div>`)}
<p class="vl__note"><strong>Audio samples:</strong> added here once the voice provider is approved. The exact voices, accents and languages available depend on the provider and are chosen with you during setup — English is standard, and other languages such as Spanish can be configured where the provider supports them.</p></div>
</div></div>
<p class="visually-hidden" data-sv-live aria-live="polite"></p>
</figure><script src="/assets/services.js" defer></script>`;
}
