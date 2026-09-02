# Owner Mobile Design QA

## Comparison target

- Source visual truth: `/Users/reiken/.codex/generated_images/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/exec-1e7cc3a4-303e-4090-96cb-ce16c71650f9.png`
- Rendered implementation: `http://127.0.0.1:4317/owner/daily`
- Final implementation screenshot: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/07-owner-daily-390x844-collapsed.png`
- Side-by-side comparison: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/08-design-comparison-390x844.png`
- State: Owner daily report list, newest-first, daily groups collapsed, light theme, authenticated preview data.

## Viewport and density normalization

- CSS comparison viewport: 390 x 844.
- Source pixels: 853 x 1844, approximately 2.19x density. It was normalized to 390 x 844 for comparison.
- Implementation pixels: 390 x 844 at 1x browser capture density.
- Additional responsive evidence:
  - iPhone 7, 375 x 667: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/13-owner-daily-iphone7-final.png`
  - iPhone 16 Pro, 402 x 874: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/12-owner-daily-iphone16pro.png`
  - iPhone 16 Pro Max, 440 x 956: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/12-owner-daily-iphone16promax.png`

## Full-view comparison evidence

- Information hierarchy matches the selected direction: compact account header, all-report summary, primary add-report action, date range, newest-first report groups, and fixed three-item bottom navigation.
- Fonts and typography: the implementation uses the existing Japanese UI font stack and preserves the source hierarchy. Small metadata remains readable at 375px; long account names truncate instead of displacing actions.
- Spacing and layout rhythm: 14px mobile page margins, consistent card gaps, 42px or larger core action targets, and a 70px fixed navigation area keep controls reachable without horizontal scrolling.
- Colors and visual tokens: the Owner flow now maps primary actions and active navigation to the existing deep-green accent. Warm neutral page and surface colors, subtle borders, and restrained elevation align with the source.
- Image and asset fidelity: the design contains no product imagery. Navigation and edit affordances use the existing Element Plus icon library; no placeholder, emoji, CSS-drawn, or custom SVG asset substitutes are present.
- Copy and content: all Owner-facing role, staff-meal, Alipay, action, validation, and repository error copy is standardized in Japanese. `老板` is displayed as `ユーザー`.
- Responsive behavior: document width equals viewport width at 375, 402, and 440px. The desktop sidebar is hidden, bottom navigation is fixed within the viewport, and the report table is replaced by an expandable mobile list with reachable edit buttons.

## Focused region comparison

A separate crop was not required because the normalized 780 x 844 side-by-side artifact keeps the header, summary typography, period control, report rows, icons, and bottom navigation readable at original inspection detail. Form and secondary-screen evidence was captured separately:

- Owner report form at 375 x 667: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/09-owner-form-iphone7.png`
- Master/settings at 375 x 667: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/10-owner-settings-iphone7.png`
- Analytics at 375 x 667: `/Users/reiken/.codex/visualizations/2026/09/02/01a0609d-8ee0-7051-9ebc-84a5f5cf5e36/owner-mobile-audit/11-owner-analytics-iphone7.png`

## Comparison history

### Iteration 1

- P2, color token drift: the first rendered primary action used Element Plus blue instead of the source deep green.
- P2, hierarchy drift: the first rendered order placed the add action before the summary and omitted the summary/list headings.
- Fixes: scoped the Owner flow to the existing `--fs-accent` token; reordered the mobile flow; added `全日報サマリー`, `日報一覧`, the edit icon, and newest-first label; adjusted summary typography and value color.
- Post-fix evidence: `07-owner-daily-390x844-collapsed.png` and `08-design-comparison-390x844.png`.

### Final pass

- No actionable P0, P1, or P2 differences remain.
- The real product keeps an explicit `ログアウト` action instead of the mock's overflow menu, and keeps separate start/end date fields plus an explicit load action. These are accepted functional constraints because they preserve existing behavior and remain usable at all target sizes.
- Dynamic report counts and amounts intentionally differ from the mock.

## Interaction and technical checks

- Expanded and collapsed a daily group; edit controls become visible and remain full-width.
- Opened the add-report dialog and navigated into the new report form.
- Navigated through all three bottom-navigation destinations.
- Confirmed mobile master cards replace desktop tables on the settings screen.
- Confirmed analytics filters stack and chart width stays within the viewport.
- Confirmed no horizontal document overflow at 375 x 667, 402 x 874, or 440 x 956.
- Checked browser console errors after the primary flow: none.
- Web tests: 238 passed.
- Full repository check, including type checks, API/Web/Domain/Amplify tests and production builds: passed.

## Follow-up polish

- P3: a future combined date-range picker could visually match the mock more closely, but the current explicit start/end fields are clearer about the existing query behavior and do not impair mobile use.

final result: passed
