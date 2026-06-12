# BCC Install Status — Kwame Tyler Agency

**Last updated:** 2026-06-11 by Claude (resident engineer)
**Agency:** Tyler Insurance and Financial Services (S-Corporation)
**Owner:** Kwame Tyler
**Agency UUID:** `98aa8b9b-92e4-4ebc-8727-aa00ce696fab`
**Primary email:** `kwametyler.businessclaude@gmail.com`

---

## Operating model

**Claude is the resident engineer for this BCC.** Rebecca handled the initial install (GitHub repo,
Vercel deploy, base schema, Edge Function). From here forward, Claude owns:
- Building agency-specific recipes (replacing placeholder seeds with the canonical 13)
- Populating all modules with real data
- Maintaining recipe health
- Schema evolution as the agency grows
- Direct commits to this repo

If it's a BCC operation, it's Claude's responsibility.

---

## Where we are right now (2026-06-11)

**Phase F + P1 complete and SHIPPED.** Historical comp_recap load is done (all 10 of 2026 Jan–May recaps loaded penny-perfect, federal YTD = $298,853.85). The GL Entry Writer post-cutover redesign shipped 2026-06-10 (migration 013) with a same-day chargeback fix (migration 014) after the first cron run failed on a negative AMD66 amount. Both May 15 and May 31 JEs are posted: $21,476.84 + $30,868.68 cash deposit + $1,309.96 benefits wash = $53,655.48 May P&L impact, ties exactly to federal_ytd Δ.

**Next major milestone:** P2 — Bank statement processor build (Phase G).

---

## Infrastructure status

| Component | Status | Notes |
|---|---|---|
| Supabase database | ✅ | 14 migrations applied through `014_gl_entry_writer_signed_amount_fix.sql` |
| Edge Function `automation-runner` v2 | ✅ | Reads `COMPOSIO_API_KEY` from Edge Function Secrets env |
| pg_cron tick | ✅ | Fires every minute; calls active recipes per their schedules |
| Composio Gmail | ⚠️ | Periodically expires — reauth at `https://platform.composio.dev/auth-configs/ac_aH5X0zGqNMTG` |
| Composio Drive | ⚠️ | Periodically expires — reauth at `https://platform.composio.dev/auth-configs/ac_uf6G2te82Xnq` |
| Composio Calendar | ✅ | Active (timezone UTC, should be ET — low-priority fix) |
| Composio Docs / Supabase / GitHub | ✅ | Active |
| Vercel deploy | ⏳ | Pending — Rebecca to push first deploy with env vars |

---

## Module data status

| Module | Schema | Data populated? |
|---|---|---|
| Persistent Memory | ✅ | ✅ 19 active rows: agency profile, business rules, financial context, S-Corp owner comp, CPA contact, operational rules, GL routing rules (2026-06-10), Composio patterns (2026-06-10), 9 session notes |
| Compliance | ✅ | ✅ 76 rules seeded; 11 calendar items |
| Chart of Accounts | ✅ | ✅ 145 SF-standard accounts + line-of-business restructure 2026-06-10: added 4011/4012 Auto, 4013/4014 Fire, 4015/4016 Std Auto, 4031 Life-Renewal, 4170 GFA Bank Referral, 4180 Non-Cash Benefits, 6120 S-Corp Owner H&W; renamed 4030 → "Life Insurance Commission - New" |
| Financials → Balance Sheet | ✅ | ✅ 12/31/2025 opening balance JE posted (`OB-2025-12-31`), $86,300.22 balanced, ties to CPA exactly |
| Financials → comp_recap | ✅ | ✅ **2026 Jan–May complete: 10 of 10 recaps, 540 rows loaded, federal YTD reconciled to $298,853.85 penny-perfect.** 2025 historical: 1 of 24 loaded (Jan 15 — proven prototype); 23 remaining (P3) |
| Financials → P&L 2026 (post-cutover) | ✅ | ✅ **SHIPPED 2026-06-11.** `SFCR-2026-05-15` and `SFCR-2026-05-31` JEs posted (64 journal lines, balanced, audit-linked via `comp_recap.journal_entry_id`). May P&L impact = $53,655.48, ties to federal_ytd Δ exactly. |
| Financials → P&L 2026 (Jan–Apr pre-cutover) | ✅ | ⏳ Q1 2026 PDF filed and registered; opening balance reflects the position at 4/30 |
| Financials → P&L 2025 | ✅ | ⏳ Will be reconstructed from full-year comp_recap once 2025 historical load completes (P3) |
| Financials → Payroll | ⚠️ | Empty — tables exist, payroll history backload pending |
| Financials → Bank | ⚠️ | Empty — bank_transactions exists, bank statement processor pending (P2) |
| Financials → Credit | ⚠️ | Empty — credit_transactions exists, credit card processor pending (P2+) |
| Financials → AIPP & ScoreBoard | ✅ | Target $81,600 set; YTD will populate from comp_recap after cron runs |
| Automations | ✅ | 4 active recipes (Daily Briefing, GL Entry Writer, Monthly Close Monitor, Producer Underperformance Watcher); 3 GL-writer recipes (Payroll/Bank/Credit) dormant pending P2+ rebuilds; 6 social-media recipes inactive pending Vercel deploy |
| Documents | ✅ | Foundational docs registered; SF Comp Recap PDFs auto-filed by parser |
| Social Media / Tasks / Goals / HR / Alerts | ⚠️ | Schemas exist; data wiring deferred until BCC web app is live |

---

## GL cutover policy (BINDING)

**Cutover date: 2026-04-30**

Stored in `settings.gl_cutover_date` (machine-readable) and `persistent_memory.operational_rules` (human-readable).

**Cutover semantics — INCLUSIVE on the pre-cutover side** (confirmed 2026-06-10):
- `gl_entry_writer` filters `recap_date > gl_cutover_date`
- 4/30/2026 stays pre-cutover archive-only — NEVER posts to JE (comes from CPA opening balance)
- 5/15/2026 and later are live, posting via the cron

**Pre-cutover** (≤ 2026-04-30): static historical archive, closed by ReynoldsJones & Associates CPA. Do not re-classify or modify without explicit agent approval. GL writers respect this date.

**Post-cutover** (> 2026-04-30): live BCC pipeline. Every transaction flows through automations. Claude is bookkeeper/accountant/CFO from this date forward.

---

## GL Entry Writer architecture (2026-06-10 redesign)

The function in migration 013 replaces the original placeholder. Key invariants:

1. **One JE per recap_date** (not one per row). `reference_number = 'SFCR-YYYY-MM-DD'`. `source = 'gl_entry_writer'`. `entry_date = recap_date`.
2. **Mapping-table-driven routing.** `comp_recap_account_mapping` holds 21 rules. Match priority: description_pattern (ILIKE) > comp_category > comp_type only. Future routing changes are pure SQL — no code deploy.
3. **Cutover-aware.** Recaps on/before the cutover are skipped.
4. **`amount_type='half_month_activity'` only.** YTD snapshots are reconciliation data, never posted (this was a latent bug in the placeholder version that would have double-counted).
5. **Benefits wash.** `BENEFITS` rows route DR 6120 / CR 4180 — zero P&L impact. The CPA grosses these up to W-2 Box 1 at year-end (S-Corp §1372).
6. **Audit round-trip.** Each posted `comp_recap` row gets `journal_entry_id` set, so any GL line traces back to the comp recap row that produced it.
7. **Idempotent.** Empty JEs (no qualifying lines) are deleted before commit; re-running posts nothing already posted.

See `supabase/migrations/013_gl_entry_writer_post_cutover_redesign.sql` for the schema + function, `supabase/migrations/014_gl_entry_writer_signed_amount_fix.sql` for the chargeback / signed-amount handling, and `supabase/recipe_seeds/14_gl_account_mapping_TEMPLATE.sql` for the per-agency seed (used by `docs/NEW_AGENCY_INSTALL_PLAYBOOK.md`).

---

## SF Comp Recap Importer — production-proven

The `sf_comp_recap_processor` pipeline was proven on Jan 15 2025 and used to load all 10 of 2026 Jan–May recaps with penny-perfect reconciliation:

- LLM parser handles all line-item shapes (handles negative clawback amounts)
- Deterministic Python post-processing fixes categorization via DESC_RULES
- Each recap loads 30 rows (15 line items × 2 amount_types: half_month_activity + ytd_snapshot)
- Reconciles to recap's own federal YTD total to the penny

Parser prompt and DESC_RULES are documented in `docs/SF_COMP_RECAP_PARSER.md`.

---

## Next actions (in priority order)

### Standing watch
1. **Monitor daily `gl_entry_writer` cron runs** — first one was 2026-06-11 16:00 UTC (failed on chargeback, fixed same day, manually re-run successfully). Next scheduled run: tomorrow 16:00 UTC. Should be a no-op (no unposted post-cutover rows) until the next SF Comp Recap arrives mid-month.
2. **Reauth Composio Gmail + Drive** (Layer 1 connectors expired in 5/26) — needed before next comp recap email lands so the Document Processor recipe can grab the attachment.

### P2 — Bank statement processor (Phase G)
3. Build `bank_statement_processor` for BofA Operating (12 PDFs 2025 + 6 for 2026 YTD)
4. Define bank-rec mapping rules (similar pattern to `comp_recap_account_mapping`)
5. Rebuild dormant `bank_gl_writer` Postgres function on the same mapping-driven pattern as `gl_entry_writer`

### P3 — Historical 2025 comp_recap load
6. Process remaining 23 of 24 2025 SF Comp Recaps in batches
7. Reconcile against 2025 year-end federal YTD targets (Dec 30 2025): $604,051.80 federal reportable
8. Mark all 2025 rows `posted_at=NOW()` (pre-cutover archive)

### P4 — Credit card processor
9. Build `credit_card_processor` for Chase Credit (12 PDFs 2025 + 6 for 2026 YTD)
10. Rebuild dormant `credit_card_gl_writer`

### P5 — Payroll
11. Build payroll backload from CPA records into `payroll_runs` + `payroll_detail`
12. Rebuild dormant `payroll_gl_writer`

### Module activation (after data foundation solid + Vercel live)
13. Seed Tasks & Goals with annual goals (AIPP target, production goals)
14. Configure Social Media accounts in `social_accounts`
15. Pre-seed content calendar with first 30 days of compliance-safe content
16. Wire up HR & People with team roster + producers

---

## Reference data — do not lose

- **Composio permanent user:** `pg-test-f05145fc-2c9f-4ded-9f5_kwametylerbusinessclaude`
- **Composio session ID (chat):** `than`
- **BCC Financial Records Drive root:** `1XjQF0vesM3ULaq-PcTqE4XZvJaNU84l6`
- **2025 folder root:** `1ODcXhUwUMoIpajpT34-fiSG1YGVwdDal`
- **SF Compensation Recaps 2025:** `1ZQNCVK7VTX9CgV0Wx1PyVi-8LhzwSvMx`
- **Gmail message ID — 2025 Comp reports:** `19e70384c33fc72d` (24 attachments)
- **Gmail message ID — Tyler Financials:** `19e56132fdc21198`
- **Edge Function ID:** `3eef1585-ab7a-479b-8a0e-4371e2e7b448`
- **Daily Briefing recipe ID:** `1dd052ab-88b9-46b9-97e0-35db07f29098`
- **GL Entry Writer recipe ID:** `a611718d-c685-43ca-9976-7dbc665e5e3f`
- **Monthly Close Monitor recipe ID:** `105e0835-59f3-4d59-8e68-553bf20cc47c`
- **Vercel anon publishable key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlza2FzZmxld3BtanRndHRndXVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTc5NTUsImV4cCI6MjA5NTQ5Mzk1NX0.M1VyM7rmqJigAYdqeiN8fm3_KFO7IzbUKAUs2XjHnAI`
- **GitHub repo:** `https://github.com/kwametylerbusinessclaude-hue/Tylerbccdashboard`
- **GitHub Composio account alias:** `kwame-tylerbcc` (login: kwametylerbusinessclaude-hue)

---

## How to resume

A future Claude session reading this document should:

1. Read all `persistent_memory` entries first (the system prompt should already trigger this) — especially the most recent `session_note` entry (the green "NEXT-CLAUDE HANDOFF" tag)
2. Read this file (`docs/INSTALL_STATUS_KWAME_TYLER.md`)
3. Read `docs/SF_COMP_RECAP_PARSER.md` if working on comp recaps
4. Read `docs/NEW_AGENCY_INSTALL_PLAYBOOK.md` if installing a fresh BCC for another agent
5. Check `automation_run_log` for any failed runs since the last session
6. Pick up at the next unchecked action from "Next actions" above

Don't start over. Don't re-explain things to the agent that are documented here. This is a continuous engineering relationship — every session builds on the last.
