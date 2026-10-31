# About page

The About page is built only from approved content. The CMS `about.page` heading, lede and body remain the source of
truth, and Owners can still edit them. The interactive views draw on the service catalogue and the CMS process steps,
so the page adds no new claims, people, dates or numbers.

Page sections, in order:

1. **Hero:** a cinematic title, the CMS lede, and an original gold illustration (`stage-launch.webp`).
2. **Pinned statement:** the homepage's scroll-words statement component, using the already-published line
   "Published prices. Counted revisions. Nothing goes live without your approval."
3. **Principles in practice:** the CMS body, split into numbered chapters.
4. **Capabilities constellation** (`engines.constellation`): six capability groups around "Your business". Selecting
   one shows its scope, the capabilities it works with (connection lines light up) and links to the real service
   pages. It supports arrow keys, touch and mouse.
5. **Journey** (`engines.journey`): the CMS process steps from "Your idea" to "Live website". The gold progress line,
   Previous/Next buttons and arrow/Home/End keys move through it. Phases follow the homepage stage controller.
6. **Craft lab** (`engines.lab`), on a fictional miniature site:
   - Responsive: a width slider drives a real container-query reflow.
   - Accessibility: keyboard order, and contrast ratios computed live using the WCAG formula.
   - Precision: an 8px grid overlay.
   - Maintainability: one accent token re-themes the miniature.
7. **Commitments:** "what you can hold us to" alongside the existing "What we will not do" list.
8. **Closing hand-over:** "Start with a conversation", leading directly into the footer.

**Oversized CRESTMONT wordmark:** preserved unchanged in the footer on every page. On About only, it gains a gold
stroke and a fill that sweeps in as the closing section hands over to it (`.footer-word--about`). With reduced motion
it appears in its final state.

Every interaction works without hover. Without JavaScript, all nodes, steps and explanations are shown as lists.
