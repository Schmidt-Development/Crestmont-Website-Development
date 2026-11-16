// Horizontal portfolio explorer (PORT-006 extension): one shared component for the homepage work section,
// /portfolio and case-study pages. Data comes only from published portfolio records; arrows, selector and counts
// are derived from them. Each project shows, in this order (services/portfolio.ts previewState):
//   1. an isolated demonstration copy from an approved, verified demo origin, where the Owner set one up;
//   2. otherwise the REAL live website, when its own headers recently permitted this origin to frame it (embed-check.ts);
//   3. the genuine screenshot, with an honest label and the Visit live website link.
// The label always says which one the visitor is looking at; a screenshot is never presented as interactive.
// Without JavaScript the same markup is an accessible project list with links (nojs.css).
import { html, safeUrl, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { remoteBrowserConfig } from "../services/remote-browser/admission.ts";
import { approvedDemoOrigins, allowLocalDemos, previewState, type PreviewState, type PortfolioProject } from "../services/portfolio.ts";

const ARROW_L = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_R = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EXTERNAL = html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3 7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ""; } };
const posterOf = (p: PortfolioProject, kind: "desktop" | "tablet" | "mobile"): string | null => {
  if (kind === "tablet") return p.tablet_screenshot_file_id ? `/portfolio-media/${p.tablet_screenshot_file_id}` : p.poster_tablet_asset;
  const asset = kind === "desktop" ? p.poster_desktop_asset : p.poster_mobile_asset;
  const file = kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id;
  return file ? `/portfolio-media/${file}` : asset;
};
/** True when the image is an uploaded screenshot file rather than a bundled demonstration-build poster (CREST-GAP-048). */
const file = (p: PortfolioProject, kind: "desktop" | "mobile"): boolean => Boolean(kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id);
/** Device viewports a demo is rendered at (CSS px). The frame scales the whole viewport down to fit — never crops it. */
export const PFX_DEVICES = { desktop: [1440, 900], tablet: [820, 1180], mobile: [390, 844] } as const;

/** Visitor-facing status over the screenshot. Internal reasons (origin not approved here, not yet verified) stay in
 *  Staff → Portfolio; a visitor only hears about a demo that is normally offered and is temporarily down. */
function visitorStatus(p: PortfolioProject, st: PreviewState): string {
  return st.kind === "unavailable" && p.demo_status === "unavailable" ? "The interactive demo is temporarily unavailable, so a screenshot is shown instead." : "";
}

export interface ExplorerOptions { variant: "home" | "portfolio" | "case"; headingLevel?: 2 | 3; /** Short-lived preview link (unpublished projects): passed to the remote browser. */ previewToken?: string }

const FLAG = { live: "Live website", remote: "Live website · remote view", embed: "Interactive demo", shot: "Screenshot" } as const;
const framed = (st: PreviewState): st is Extract<PreviewState, { kind: "live" | "embed" }> => st.kind === "live" || st.kind === "embed";

/** Renders the explorer and registers exactly the origins it frames (live sites verified to permit this origin, and
 *  approved demo origins) on this response's CSP frame-src. */
export function portfolioExplorer(ctx: AppContext, projects: PortfolioProject[], opts: ExplorerOptions): SafeHtml {
  if (!projects.length) return html``;
  const approved = approvedDemoOrigins(ctx.env.PORTFOLIO_DEMO_ORIGINS, { allowLocal: allowLocalDemos(ctx.env.ENVIRONMENT) });
  const remoteOn = remoteBrowserConfig(ctx.env).enabled;
  const states = projects.map((p) => previewState(p, approved, Date.now(), remoteOn));
  ctx.frameSrc = [...new Set([...(ctx.frameSrc ?? []), ...states.flatMap((s) => (framed(s) ? [s.origin] : []))])];
  const n = projects.length;
  const nameAt = (i: number) => projects[(i + n) % n].name;

  const slides = projects.map((p, i) => {
    const st = states[i];
    const desk = posterOf(p, "desktop"), tab = posterOf(p, "tablet"), mob = posterOf(p, "mobile");
    const host = framed(st) || st.kind === "remote" ? hostOf(st.url) : hostOf(p.live_url);
    const kind = st.kind === "live" ? "live" : st.kind === "remote" ? "remote" : st.kind === "embed" ? "embed" : "shot";
    return html`<li class="pfx__slide pfx__slide--${kind}" id="pfx-${p.slug}" data-pfx-slide data-index="${i}" data-name="${p.name}" data-kind="${kind}" data-live-url="${safeUrl(p.live_url)}"
 ${framed(st) ? html`data-frame-url="${st.url}" data-frame-origin="${st.origin}"` : ""} ${st.kind === "remote" ? html`data-remote-slug="${p.slug}" data-remote-host="${host}"` : ""} ${st.kind === "embed" ? html`data-demo-url="${st.url}" data-demo-origin="${st.origin}"` : ""} aria-roledescription="slide" aria-label="${`${i + 1} of ${n}: ${p.name}`}">
<div class="pfx__viewport" data-pfx-viewport>
  <div class="pfx__chrome" aria-hidden="true"><span class="pfx__dots"><i></i><i></i><i></i></span><span class="pfx__url" data-pfx-url>${host}</span><span class="pfx__flag pfx__flag--${kind}" data-pfx-flag>${kind === "live" || kind === "remote" ? html`<span class="pfx__pulse"></span>` : ""}${FLAG[kind]}</span></div>
  <div class="pfx__screen" data-pfx-screen>
    <div class="pfx__stage" data-pfx-stage>
    ${desk ? html`<img class="pfx__poster pfx__poster--desktop" src="${desk}" alt="${`Screenshot of the ${p.name} website on a desktop screen${file(p, "desktop") ? "" : " (demonstration build with sample data)"}`}" width="1440" height="900" loading="${i === 0 ? "eager" : "lazy"}" decoding="async">`
      : kind === "live" || kind === "remote" ? html`<div class="pfx__poster pfx__poster--loading" aria-hidden="true"><span class="pfx__spinner"></span><span class="pfx__loading-name">${p.name}</span><span class="pfx__loading-host">${host}</span></div>`
      : html`<div class="pfx__poster pfx__poster--missing">Screenshot pending</div>`}
    ${tab ? html`<img class="pfx__poster pfx__poster--tablet" src="${tab}" alt="${`Screenshot of the ${p.name} website on a tablet (demonstration build with sample data)`}" width="820" height="1180" loading="lazy" decoding="async">` : ""}
    ${mob ? html`<img class="pfx__poster pfx__poster--mobile" src="${mob}" alt="${`Screenshot of the ${p.name} website on a phone${file(p, "mobile") ? "" : " (demonstration build with sample data)"}`}" width="390" height="844" loading="lazy" decoding="async">` : ""}
    </div>
    <div class="pfx__status" data-pfx-status role="status">${visitorStatus(p, st)}</div>
  </div>
</div>
<div class="pfx__meta">
  <div class="pfx__meta-main">
    <p class="pfx__count"><span class="pfx__count-n">${String(i + 1).padStart(2, "0")}</span> / ${String(n).padStart(2, "0")} · ${p.industry}</p>
    ${opts.headingLevel === 2 ? html`<h2 class="pfx__name">${p.name}</h2>` : html`<h3 class="pfx__name">${p.name}</h3>`}
    <p class="pfx__desc">${p.description.split("\n")[0]}</p>
  </div>
  <div class="pfx__links">
    ${st.kind === "embed" ? html`<span class="pfx__label">Interactive demo — no real transactions</span>` : st.kind === "live" ? html`<span class="pfx__label pfx__label--live">The real, live website — fully interactive</span>` : st.kind === "remote" ? html`<span class="pfx__label pfx__label--live">The real, live website, shown through Crestmont's remote browser — sign-in, forms and purchases are turned off</span>` : ""}
    ${opts.variant !== "case" ? html`<a class="pfx__link" href="/portfolio/${p.slug}">Case study</a>` : ""}
    ${st.kind === "embed" ? html`<a class="pfx__link pfx__link--demo" href="${safeUrl(st.url)}" target="_blank" rel="noopener noreferrer">Open demo in a new tab ${EXTERNAL}</a>` : ""}
    <a class="pfx__link pfx__link--live" href="${safeUrl(p.live_url)}" target="_blank" rel="noopener noreferrer">Visit live website ${EXTERNAL}<span class="visually-hidden"> (opens the operational ${p.name} website in a new tab)</span></a>
  </div>
</div>
</li>`;
  });

  const many = n > 1;
  // CREST-GAP-047: without anything framed there is nothing to click inside or reload, so the Reload control is not
  // rendered and the hint describes what the visitor actually sees.
  const anyRemote = states.some((s) => s.kind === "remote");
  const anyLive = states.some((s) => s.kind === "live") || anyRemote, anyDemo = states.some((s) => s.kind === "embed");
  const anyFrame = anyLive || anyDemo;
  const hint = anyFrame
    ? `Scroll and click inside the ${anyLive && !anyDemo ? "website" : anyLive ? "website or demo" : "demo"} to explore it${many ? "; the arrows switch projects" : ""}.${anyLive ? " Live websites are the real, working sites, exactly as their visitors see them." : ""}${anyDemo ? ` Demos are isolated demonstration copies with sample data — nothing you do ${anyLive ? "in a demo" : ""} reaches the real businesses.`.replace("  ", " ") : ""}`
    : `Screenshots of ${many ? "each website" : "the website"}${projects.every((p) => !p.desktop_screenshot_file_id) ? `${many ? "'s" : "'s"} demonstration build, which uses sample data` : ""}.${many ? " Use the arrows to switch projects, or" : ""} ${many ? "visit" : "Visit"} the live website to explore it.`;
  return html`<div class="pfx pfx--${opts.variant}${many ? "" : " pfx--single"}" data-pfx data-mode="desktop" data-count="${n}"${opts.previewToken ? html` data-preview="${opts.previewToken}"` : ""} role="region" aria-roledescription="carousel" aria-label="Portfolio projects">
<p class="visually-hidden" aria-live="polite" data-pfx-live></p>
<div class="pfx__row">
  ${many ? html`<button type="button" class="pfx__arrow pfx__arrow--prev" data-pfx-prev aria-label="${`Previous project: ${nameAt(n - 1)}`}">${ARROW_L}</button>` : ""}
  <div class="pfx__window" data-pfx-window><ol class="pfx__track" data-pfx-track>${slides}</ol></div>
  ${many ? html`<button type="button" class="pfx__arrow pfx__arrow--next" data-pfx-next aria-label="${`Next project: ${nameAt(1)}`}">${ARROW_R}</button>` : ""}
</div>
<div class="pfx__bar">
  ${many ? html`<div class="pfx__pages" role="group" aria-label="Choose a project">${projects.map((p, i) => html`<button type="button" class="pfx__page" data-pfx-go="${i}" aria-label="${`Show ${p.name} (${i + 1} of ${n})`}"${i === 0 ? html` aria-current="true"` : ""}><span>${p.name}</span></button>`)}</div>` : ""}
  <div class="pfx__tools" role="group" aria-label="Demo controls">
    <div class="pfx__seg" role="group" aria-label="Device viewport"><button type="button" class="pfx__tool" data-pfx-mode="desktop" aria-pressed="true">Desktop</button><button type="button" class="pfx__tool" data-pfx-mode="tablet" aria-pressed="false">Tablet</button><button type="button" class="pfx__tool" data-pfx-mode="mobile" aria-pressed="false">Mobile</button></div>
    ${anyRemote ? html`<button type="button" class="pfx__tool" data-pfx-back aria-label="Back (remote view)">Back</button><button type="button" class="pfx__tool" data-pfx-forward aria-label="Forward (remote view)">Forward</button>` : ""}
    ${anyFrame ? html`<button type="button" class="pfx__tool" data-pfx-reset>${anyDemo && !anyLive ? "Reset demo" : "Reload"}</button>` : ""}
    <button type="button" class="pfx__tool" data-pfx-expand aria-pressed="false">Full screen</button>
  </div>
</div>
<p class="pfx__hint">${hint}</p>
</div><script src="/assets/portfolio.js" defer></script>`;
}
