# Hallmark redesign verification · 2026-11-04

- Static sweep: 7 files; 0 FAIL, 0 WARN, 1 ANSWERED (F4: shared ink primary/send recipe).
- Render tier was not run: this host requires all browser interactions through CUA. Real CUA captures and layout inspection were used instead; no rendered-linter pass is claimed.
- Fresh-context finish reviewer: ship after resolving narrow button wrapping, input discoverability, and hidden latest-run failures. One confirming round returned 3 resolved.
- Subsequent user correction: replace conspicuous outlined controls and brown focus with softly filled controls and neutral keyboard focus. Resource page simplified; project path condensed. This direction supersedes the earlier outlined-input treatment.
- Final direct CUA check: 1440 × 900 conversation, gateway and resource page; 375 × 812 resource page, scrollWidth = 375. Keyboard focus styles retained, native labels and controls retain accessible names. User-provided screenshot drove the refinement.
- Judged clauses: actual app content and handlers; no invented proof or branding, no hero/marketing sections, no decorative status dots, no hover on static content. Shared capped conversation width, restrained surfaces and no motion dependency. App scope exempts landing-page fold/section/word budgets.
- Material: no placeholder image slots or external stock assets. Screenshots show real local task output.

- Latest iteration: conversation-first Draft and a single combined model/effort Popover based on user screenshots; model list replaces the effort panel inside the same surface. Native macOS app updated, archived list/restore and default project-free entry checked. 375px viewport scrollWidth = 375.
- Added 200ms composited popover enter / 140ms exit, 180ms panel swap and short drawer/draft entry. Reduced-motion fallback retained. No frame-rate benchmark is claimed.
- Final static sweep: 9 files, 0 FAIL. F7 warns about repeated neutral containers; dismissed after inspection: archive search, settings search and resource input deliberately reuse the same input recipe. Tool output and timeline use distinct placement and labels; this is an app control system.
- A separate source review found existing-chat drafts were lost when leaving for settings. Fixed by storing each draft in Shell and clearing only submitted text.
- Compact controls refinement: two-row composer, focus indicated by the whole surface instead of a textarea outline; 720 × 169px dock at a 1440px viewport. Effort popover is 260 × 118px with actual discrete stops rendered as white ticks. Lightning appears only for models advertising the priority service tier; its pressed state reflects the actual request setting.
- CUA verified four DeepSeek stops and five GPT-6-Luna stops, exact endpoint alignment, Home/End/ArrowRight input, combined model switching, and no horizontal overflow at 375px and 1440px. Native macOS app replaced and reopened. Source review independently checked Radix thumb inset alignment; static sweep remains 0 FAIL with the existing F7 warning and F4 answer.

- Fast-mode correction: read Magpie service_tiers instead of deleting all icons. CUA confirmed DeepSeek has no lightning, GPT-6-Luna has an operable toggle, and changing reasoning retains the setting. Disabled pending controls prevent stale asynchronous saves from overwriting fast mode. The 260 × 118px panel and real discrete tick counts are retained.
