// Horizontal portfolio explorer (PORT-006 extension): one shared component for the homepage work section,
// /portfolio and case-study pages. Data comes only from published portfolio records; arrows, selector and counts
// are derived from them. Interactive demos are embedded only from approved, verified, isolated demo origins
// (services/portfolio.ts demoState); everything else shows the genuine poster with an honest status.
// Without JavaScript the same markup is an accessible project list with links (nojs.css).
import { html, safeUrl, type SafeHtml } from "../lib/html.ts";
import type { AppContext } from "../app/context.ts";
import { approvedDemoOrigins, allowLocalDemos, demoState, type PortfolioProject } from "../services/portfolio.ts";

const ARROW_L = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M14.5 5.5 8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ARROW_R = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="M9.5 5.5 16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const EXTERNAL = html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3 7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return ""; } };
const posterOf = (p: PortfolioProject, kind: "desktop" | "tablet" | "mobile"): string | null => {
  if (kind === "tablet") return p.poster_tablet_asset;
  const asset = kind === "desktop" ? p.poster_desktop_asset : p.poster_mobile_asset;
  const file = kind === "desktop" ? p.desktop_screenshot_file_id : p.mobile_screenshot_file_id;
  return file ? `/portfolio-media/${file}` : asset;
};
/** Device viewports a demo is rendered at (CSS px). The frame scales the whole viewport down to fit — never crops it. */
export const PFX_DEVICES = { desktop: [1440, 900], tablet: [820, 1180], mobile: [390, 844] } as const;

export interface ExplorerOptions { variant: "home" | "portfolio" | "case"; headingLevel?: 2 | 3 }

/** Renders the explorer and registers the approved demo origins it embeds on this response's CSP frame-src. */
export function portfolioExplorer(ctx: AppContext, projects: PortfolioProject[], opts: ExplorerOptions): SafeHtml {
  if (!projects.length) return html``;
  const approved = approvedDemoOrigins(ctx.env.PORTFOLIO_DEMO_ORIGINS, { allowLocal: allowLocalDemos(ctx.env.ENVIRONMENT) });
  const states = projects.map((p) => demoState(p, approved));
  ctx.frameSrc = [...new Set([...(ctx.frameSrc ?? []), ...states.flatMap((s) => (s.kind === "embed" ? [s.origin] : []))])];
  const n = projects.length;
  const nameAt = (i: number) => projects[(i + n) % n].name;

  const slides = projects.map((p, i) => {
    const st = states[i];
    const desk = posterOf(p, "desktop"), tab = posterOf(p, "tablet"), mob = posterOf(p, "mobile");
    const demoHost = st.kind === "embed" ? hostOf(st.url) : hostOf(p.live_url);
    return html`<li class="pfx__slide" id="pfx-${p.slug}" data-pfx-slide data-index="${i}" data-name="${p.name}"
 ${st.kind === "embed" ? html`data-demo-url="${st.url}" data-demo-origin="${st.origin}"` : ""} aria-roledescription="slide" aria-label="${`${i + 1} of ${n}: ${p.name}`}">
<div class="pfx__viewport" data-pfx-viewport>
  <div class="pfx__chrome" aria-hidden="true"><span class="pfx__dots"><i></i><i></i><i></i></span><span class="pfx__url" data-pfx-url>${demoHost}</span><span class="pfx__flag">${st.kind === "embed" ? "Demo" : "Screenshot"}</span></div>
  <div class="pfx__screen" data-pfx-screen>
    <div class="pfx__stage" data-pfx-stage>
    ${desk ? html`<img class="pfx__poster pfx__poster--desktop" src="${desk}" alt="${`Screenshot of the ${p.name} website on a desktop screen`}" width="1440" height="900" loading="${i === 0 ? "eager" : "lazy"}" decoding="async">` : html`<div class="pfx__poster pfx__poster--missing">Screenshot pending</div>`}
    ${tab ? html`<img class="pfx__poster pfx__poster--tablet" src="${tab}" alt="${`Screenshot of the ${p.name} website on a tablet`}" width="820" height="1180" loading="lazy" decoding="async">` : ""}
    ${mob ? html`<img class="pfx__poster pfx__poster--mobile" src="${mob}" alt="${`Screenshot of the ${p.name} website on a phone`}" width="390" height="844" loading="lazy" decoding="async">` : ""}
    </div>
    <div class="pfx__status" data-pfx-status role="status">${st.kind === "embed" ? "" : st.kind === "unavailable" ? st.reason : "An interactive demo is not available for this project; the screenshot shows the live website."}</div>
  </div>
</div>
<div class="pfx__meta">
  <div class="pfx__meta-main">
    <p class="pfx__count"><span class="pfx__count-n">${String(i + 1).padStart(2, "0")}</span> / ${String(n).padStart(2, "0")} · ${p.industry}</p>
    ${opts.headingLevel === 2 ? html`<h2 class="pfx__name">${p.name}</h2>` : html`<h3 class="pfx__name">${p.name}</h3>`}
    <p class="pfx__desc">${p.description.split("\n")[0]}</p>
  </div>
  <div class="pfx__links">
    ${st.kind === "embed" ? html`<span class="pfx__label">Interactive demo — no real transactions</span>` : ""}
    ${opts.variant !== "case" ? html`<a class="pfx__link" href="/portfolio/${p.slug}">Case study</a>` : ""}
    ${st.kind === "embed" ? html`<a class="pfx__link pfx__link--demo" href="${safeUrl(st.url)}" target="_blank" rel="noopener noreferrer">Open demo in a new tab ${EXTERNAL}</a>` : ""}
    <a class="pfx__link pfx__link--live" href="${safeUrl(p.live_url)}" target="_blank" rel="noopener noreferrer">Visit live website ${EXTERNAL}<span class="visually-hidden"> (opens the operational ${p.name} website in a new tab)</span></a>
  </div>
</div>
</li>`;
  });

  const many = n > 1;
  return html`<div class="pfx pfx--${opts.variant}${many ? "" : " pfx--single"}" data-pfx data-mode="desktop" data-count="${n}" role="region" aria-roledescription="carousel" aria-label="Portfolio projects">
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
    <button type="button" class="pfx__tool" data-pfx-reset>Reset demo</button>
    <button type="button" class="pfx__tool" data-pfx-expand aria-pressed="false">Expand</button>
  </div>
</div>
<p class="pfx__hint">Scroll and click inside the website to explore it; the arrows switch projects. Demos use isolated demonstration copies with sample data — nothing you do reaches the real businesses.</p>
</div><script src="/assets/portfolio.js" defer></script>`;
}
