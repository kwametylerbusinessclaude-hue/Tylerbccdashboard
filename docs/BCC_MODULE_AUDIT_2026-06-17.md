# BCC Module Audit — 2026-06-17

> Pre-flight data-state audit for task `7e7c16d5` (Vercel deploy + module-by-module web app audit).
> Run by Claude solo. Live URL verification still pending — Kwame to share the Vercel URL and walk each module against this baseline.

---

## Cross-cutting state

| Check | Result | Notes |
|---|---|---|
| `agency` row | 1 row, name="Tyler Insurance and Financial Services LLC" | Entity LLC, status active, owner Kwame Tyler, setup 2026-05-28 |
| `agency.vercel_url` | **NULL** ⚠️ | Needs to be set once Kwame shares the live URL. Backfill into `agency.vercel_url` AND persistent_memory.agency_profile |
| `agency` SF rates | smvc_rate_pc=9.0 · blended_rate_other=9.0 · lapse_rate_annual=10.0 | Confirmed 2026-06-16 evening as operating defaults (not placeholders) |
| Derived views | `v_income_statement`, `v_balance_sheet`, `v_comp_recap_activity` all present | Migration 006 + comp recap activity view |
| anon role SELECT grants | 51 tables | Healthy — anon access NOT locked down |
| Table inventory | 38 of 39 expected tables present | Only `monthly_financials` missing (CPA-loaded data, optional enrichment) |
| automation-runner Edge Function | v7 active, ezbr_sha256 318120eb… | verify_jwt=false; cron ticking every 30 min cleanly |

---

## Module-by-module audit

### 1. Dashboard

**Should render:**
- **Header:** "Tyler Insurance and Financial Services LLC" — Kwame Tyler, Atlanta GA
- **Open Tasks widget:** 21 tasks (5 high, 13 medium, 3 low) — the 12 SFL weekly goals dominate the list
- **Active Alerts widget:** 2 unresolved (both info-level, both fired 2026-06-17): L&H pace running ~10% behind 2025 + June 2026 production data gap
- **Compliance Activity widget:** EMPTY (compliance_log = 0 rows) — Kwame has not formally logged any compliance reviews yet
- **Monthly Close widget (May 2026):** 10 items — 8 closed/N/A, 2 pending (Payroll Reports + SF Deduction Statement, both BLOCKED EXTERNAL waiting on task `5052beba`)
- **AIPP Progress card (program year 2026):** **$25,558.65 earned / $25,895.79 target = 98.7% achievement** — essentially AT target with half the year still ahead. (Also: a 2027 row exists, target $26,000.)
- **Revenue YTD card (2026):** $64,885.55 from v_income_statement (34 rows, period 2026-05-01 only — see Financials note below about partial year coverage)
- **Upcoming Compliance widget:** Pulls next 30 days from `compliance_rules` and `compliance_calendar` (14 calendar rows seeded)

**Flags:** none. Dashboard is well-fed.

---

### 2. Financials

**Should render:**
- **P&L tab:** v_income_statement returns 34 rows for 2026, summing to $64,885.55. All entries are dated 2026-05-01 — meaning the GL Entry Writer has only posted ONE period to date. Comp recap has 2,234 rows across 34 periods (Jan 15 2025 → May 31 2026); journal_entries has 20 entries with $663,450.52 in balanced debits/credits. **The P&L view materializing only one month is expected** — pre-cutover periods don't post to GL by design (per the GL CUTOVER rule, Apr 30 2026 cutover). Post-cutover only May 2026 has comp_recap data that's been posted via gl_entry_writer.
- **Balance Sheet tab:** v_balance_sheet view present; agent will see opening balances + the 20 journal entries posted.
- **SF Compensation tab:** 2,234 comp_recap rows, 34 distinct periods. Full Jan 2025 → May 2026 coverage. **Rich.**
- **General Ledger tab:** 20 journal_entries, 115 journal_lines, $663,450.52 balanced. chart_of_accounts has 158 accounts available for name lookups.
- **Payroll tab:** **EMPTY** ⚠️ — payroll_runs=0, payroll_detail=0. Awaiting Paychex CSV ingestion or task `5052beba` (May portal downloads, due 2026-06-24).
- **Bank tab:** ⚠️ **bank_accounts = 0 rows** but `bank_transactions = 269 rows`. The Bank tab will likely render "no accounts" even though transactions exist. **Real setup gap to investigate** — see "Setup gaps" section.
- **Credit tab:** 1 credit_account, 831 credit_transactions.
- **AIPP / ScoreBoard tab:** AIPP populated (98.7%); **scoreboard_tracking = 0 rows** ⚠️ — ScoreBoard sub-section will be empty until the tracking table is populated.

**Flags:**
- Bank tab will look broken because of bank_accounts=0 (resolvable with a single INSERT once the actual accounts are confirmed)
- Payroll tab and ScoreBoard sub-section will be visibly empty
- P&L 1-month coverage is by design (cutover) — flag for Kwame to know it's not a bug

---

### 3. ComplianceCenter

**Should render:**
- **Rules tab:** 76 compliance_rules seeded (matches Project Claude system prompt baseline)
- **History tab:** **EMPTY** — compliance_log = 0 rows. Kwame's Claude hasn't been writing to compliance_log during conversations. Per MDW: "compliance_log writes happen via Project Claude's compliance check workflow." If Kwame wants the History tab populated, future Claude sessions need to INSERT into compliance_log after each rule check.
- **Calendar tab:** 14 compliance_calendar rows seeded

**Flags:** None — empty History is expected, not broken.

---

### 4. Documents

**Should render:**
- 104 documents listed (most recent first). 34 SF Comp Recaps + Paychex + Chase + BofA + CPA monthly P&Ls + the two 1099-NEC drafts created tonight.

**Flags:** None — documents module is rich.

---

### 5. HRPeople

**Should render:**
- **Roster tab:** 1 active staff — Kwame Tyler / Agent/Owner-Producer
- **Applicants tab:** EMPTY — no resumes have flowed in via the Resume Auto-Import recipe yet
- **Performance tab:** Should render — staff.role "Agent/Owner-Producer" matches the producer regex (`%LSP%|%Producer%|%Financial Services%`). producer_production has 153 rows for Kwame across 17 periods × 9 lines of business. SF rates set. Lapse rate set. Performance projections should compute.
- **Onboarding tab:** EMPTY (no new hires)
- **Reviews tab:** **EMPTY** — staff_performance = 0 rows (no monthly reviews logged yet)
- **Commissions tab:** **EMPTY** ⚠️ — commission_structures = 0 rows. Single-agent agency so technically not needed, but if Kwame adds a producer this table needs an INSERT first.

**Flags:** Performance tab should be the headline render and should work; the other tabs being empty is partly by design (1-staff agency) and partly waiting on real triggers (resumes arriving, monthly reviews being logged).

---

### 6. SocialMedia

**Should render:**
- **Calendar tab:** 32 content_calendar rows — 22 draft, 6 scheduled, 4 posted. The 9 Q3 gap-fill drafts inserted earlier today plus the original 23.
- **Connected Accounts tab:** **EMPTY** — social_accounts = 0 rows. By design until Kwame completes the FB Page + LinkedIn presence work (task `95c76f8a`) and connects Composio FB/LI integrations (task `0711d898`).
- **Engagement tab:** EMPTY — social_analytics = 0 rows. Populated by a per-client opt-in recipe not in the canonical 13.

**Flags:** Connected Accounts and Engagement empty is expected. Calendar should render well.

---

### 7. AlertsNotifications

**Should render:**
- 2 active alerts (both info-level, both 2026-06-17):
  - `5e688211` — "L&H pace: SFL first-year writing running ~10% behind 2025"
  - `cf9696fd` — "Kwame Tyler: Jun 2026 production not yet ingested" (data_gap)
- 14 notification_preferences rows (preferences populated)

**Flags:** None.

---

### 8. Automations

**Should render:**
- **Recipes tab:** 13 recipes — 10 active and last-run-status=success (bank_gl_writer, cc_gl_writer, daily_briefing_composer, document_processor_orchestrator, email_archiver_orchestrator, gl_entry_writer, monthly_close_generator, monthly_close_monitor, payroll_gl_writer, producer_underperformance_watcher) + 3 inactive (social_scheduler_facebook/linkedin/instagram_orchestrator, correctly inactive pending Kwame activation gate).
- **Run Log tab:** 161 runs in last 30 days — healthy cadence.

**Flags:** None — this is the cleanest module by data state.

---

### 9. TasksGoals

**Should render:**
- **Tasks tab:** 21 open tasks. Sorted by priority then due_date.
- **Goals tab:** 3 goals — all Q3 2026 SFL First-Year Writing tiers (Floor $3,544, Stretch $4,430 active/primary, Push $5,316). All current_value=0 (tracking not yet wired to production data).

**Flags:** Goal current_value tracking is wired to 0 — when SFL first-year writing premium starts being booked, the current_value won't auto-update unless there's a job updating it. Worth a follow-up to confirm whether the producer_underperformance_watcher recipe (or another) updates goals.current_value, or if this is owner-tracked manually.

---

### 10. PersistentMemory

**Should render:**
- Per MDW: this module is **currently mock-only**. Full wiring queued for a future sprint.
- Even though the persistent_memory table has 68 rows for this agency (rich!), the module itself won't show them yet. Project Claude (this agent) READING from the table works regardless.

**Flags:** Expected. Not a bug. Worth confirming the module shows its "mock data" state and doesn't crash.

---

### 11. Settings

**Should render:**
- **Profile tab:** agency row info — name, owner, entity, contact, rates
- **Team tab:** 1 user (table not agency-filtered in audit, but should show whoever signs in)
- **About tab:** Static — "Keep It Connected" self-heal hero card
- **Connectors tab:** 34 settings rows (confirms credentials are populated; values not shown). composio_account_id should be on the agency row.

**Flags:** None on data state. Worth Kwame eyeballing the About tab to confirm the Keep It Connected card renders green.

---

## Setup gaps surfaced by this audit

These are real items to close, separate from the live-URL audit Kwame still owes:

1. **`agency.vercel_url IS NULL`** — UPDATE after Kwame shares URL. Mirror into persistent_memory.agency_profile.
2. **`bank_accounts = 0` but `bank_transactions = 269`** — bank_accounts table needs INSERT for the Chase Operating Account that the 269 transactions belong to. Without this, the Financials → Bank tab will render "no accounts." Single INSERT, ~30 seconds; should be done before Kwame opens the app.
3. **`scoreboard_tracking = 0`** — Financials AIPP/ScoreBoard tab → ScoreBoard sub-section will be empty. Either backfill from comp_recap (likely) or accept as empty if ScoreBoard tracking is intentionally manual.
4. **`compliance_log = 0`** — History tab will show empty. Not a bug. Going forward, when Kwame's Claude runs a compliance review, INSERT into compliance_log to populate the audit trail.
5. **`payroll_runs = 0` / `payroll_detail = 0`** — Awaiting May portal downloads from Paychex (task `5052beba`). Will populate naturally once that task closes.
6. **`commission_structures = 0`** — Single-staff agency, OK for now. Add when 2nd producer hired.
7. **`monthly_financials` table missing** — CPA-loaded P&L data table (Path A install enrichment per session notes). Not blocking any module rendering; flagged so we know what the schema audit query would say.

---

## MDW doc drift discovered (separate cleanup task — not blocking)

The `docs/MODULE_DATA_WIRING.md` was last updated 2026-05-10 and has drifted from the actual DB schema in these places:

| MDW says | Actual column | Real-bug? |
|---|---|---|
| `agency.agency_name` | `agency.name` | No (Dashboard.jsx doesn't reference `agency_name`) |
| `alerts.resolved` | `alerts.is_resolved` + `resolved_at` | No (AlertsNotifications.jsx uses `is_resolved` / `resolved_at`) |
| `journal_lines.entry_id` | `journal_lines.journal_entry_id` | No (Financials.jsx doesn't reference `entry_id`) |
| `producer_production.producer_id` | `producer_production.staff_id` | No (HRPeople.jsx doesn't reference `producer_id`) |
| `compliance_rules` count = 57 (migration 002 baseline) | 76 rows currently | Doc count stale |
| `chart_of_accounts` count = 145 (system-prompt baseline) | 158 rows currently | System-prompt stale |
| `classification_rules` count = 7 (session note baseline) | 13 rows currently | Session-note stale |

**Recommendation:** queue a separate task to refresh `docs/MODULE_DATA_WIRING.md` with current column names + the schema audit query in `tools/schema_audit_query.sql`. Not blocking tonight's live audit.

---

## When Kwame is at the keyboard

Use this doc as the cross-check. Open each module and verify against the "Should render" sections. The audit should take ~10 minutes if no surprises; longer if real bugs surface.

Two specific things to validate:
1. **Bank tab in Financials** — does it render the 269 transactions even without a bank_accounts row, or does it show "no accounts"? If the latter, add the bank_accounts row before declaring Bank tab "broken."
2. **PersistentMemory module** — confirm it shows mock data state without crashing (real wiring not yet shipped).

If anything else looks wrong, capture the exact symptom and we'll diagnose against this baseline.

---

*Generated by Claude · 2026-06-17 ~23:50 UTC · session "able"*
*Repo state at audit time: HEAD = `9a3396ff` (docs/DOC_PROCESSOR_V2_1_REBUILD.md commit)*
*Persisted as: `docs/BCC_MODULE_AUDIT_2026-06-17.md`*
