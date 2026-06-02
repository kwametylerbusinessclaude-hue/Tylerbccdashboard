# BCC Install Status — Kwame Tyler Agency

**Last updated:** 2026-05-31 by Claude (resident engineer)
**Agency:** Tyler Insurance and Financial Services (S-Corporation)
**Owner:** Kwame Tyler
**Agency UUID:** `98aa8b9b-92e4-4ebc-8727-aa00ce696fab`
**Primary email:** `kwametyler.businessclaude@gmail.com`

---

## Operating model

**Claude is the resident engineer for this BCC.** Rebecca handled the initial install (GitHub repo,
Vercel deploy, base schema, Edge Function). From here forward, Claude owns:
- Building agency-specific recipes (replacing the placeholder seeds with the canonical 12)
- Populating all modules with real data
- Maintaining recipe health
- Schema evolution as the agency grows
- Direct commits to this repo

The BCC architecture is built around Claude as operator — see the training guide for the
full picture. Bottom line: **if it's a BCC operation, it's Claude's responsibility.**

---

## Infrastructure status (all proven working)

| Component | Status | Notes |
|---|---|---|
| Supabase database | ✅ | 14 migrations applied; `comp_recap` semi-monthly schema; activity view derives half-month from YTD snapshots |
| Edge Function `automation-runner` v2 | ✅ | Reads `COMPOSIO_API_KEY` from Edge Function Secrets env (env-first, settings-fallback) |
| pg_cron tick | ✅ | Fires every minute; only fires the 4 active recipes |
| Composio Gmail (permanent user) | ⚠️ | Expired — needs reauth at https://platform.composio.dev/auth-configs/ac_aH5X0zGqNMTG |
| Composio Drive (permanent user) | ⚠️ | Expired — needs reauth at https://platform.composio.dev/auth-configs/ac_uf6G2te82Xnq |
| Composio Calendar (permanent user) | ✅ | Active (timezone is UTC — should be ET, low-priority fix) |
| Composio Docs (permanent user) | ✅ | Active |
| Composio Supabase/GitHub (permanent user) | ✅ | Active |
| Vercel deploy | ⏳ | Pending — Rebecca to push first deploy with env vars |

---

## Module data status

| Module | Schema | Data populated? |
|---|---|---|
| Persistent Memory | ✅ | ✅ Agency profile, business context, financial context, S-Corp owner comp, CPA firm contact, operational rules logged |
| Compliance | ✅ | ✅ 76 rules seeded; 11 calendar items |
| Chart of Accounts | ✅ | ✅ 145 SF-specific accounts + Capital Stock added |
| Financials → Balance Sheet | ✅ | ✅ 12/31/2025 opening balance JE posted (`OB-2025-12-31`), $86,300.22 balanced; ties to CPA financials exactly |
| Financials → P&L Jan-Apr 2026 | ✅ | ⏳ Q1 2026 PDF filed and registered (`awaiting_je_post`); JEs deferred until comp_recap parsing complete |
| Financials → P&L 2025 | ✅ | ⏳ Will be reconstructed from comp_recap totals + bank statement detail (CPA only provided annual, not monthly) |
| Financials → comp_recap | ✅ | ⚙️ 1 of 34 recaps loaded (Jan 15 2025 — 42 rows, reconciled to penny). 33 remaining |
| Financials → Payroll | ⚠️ | Empty — payroll_runs/payroll_detail tables exist but no data |
| Financials → Bank | ⚠️ | Empty — bank_transactions table exists but no data |
| Financials → Credit | ⚠️ | Empty — credit_transactions table exists but no data |
| Financials → AIPP & ScoreBoard | ✅ | Schema seeded with target ($81,600); YTD will populate from comp_recap once batch is done |
| Automations | ✅ | 4 active recipes (Daily Briefing, GL Entry Writer, Monthly Close Monitor, Producer Underperformance Watcher); 6 disabled placeholders awaiting Claude rebuild |
| Social Media | ⚠️ | Schema exists; no platforms configured in `social_accounts`; no content in `content_calendar` |
| Tasks & Goals | ⚠️ | Schema exists; no data |
| HR & People | ⚠️ | Schema exists; agent self-registered in `staff`; no other team members; no producers in `producer_production` |
| Documents | ✅ | 4 documents registered: 2024-25 Financial Statements, 2026 Draft Financial Statements, Jan 15 2025 SF Comp Recap |
| Alerts | ⚠️ | Schema exists; no active alerts |

---

## GL cutover policy (BINDING)

**Cutover date: 2026-04-30**

Stored in:
- `settings.gl_cutover_date` (machine-readable)
- `persistent_memory.operational_rules` (human-readable)

**Pre-cutover** (≤ 2026-04-30): static historical archive, closed by ReynoldsJones & Associates CPA.
Do not re-classify or modify without explicit agent approval. GL writers respect this date.

**Post-cutover** (≥ 2026-05-01): live BCC pipeline. Every transaction flows through automations.
Claude is the bookkeeper/accountant/CFO from this date forward.

---

## SF Comp Recap Importer — proven prototype

The `sf_comp_recap_processor` was proven on Jan 15, 2025 with **penny-perfect reconciliation**:

- 21 line items parsed correctly (handles negative clawback amounts)
- 42 rows inserted to `comp_recap` (21 ytd_snapshot + 21 half_month_activity)
- All product families correctly categorized via deterministic Python post-processing
- Reconciles to recap source: $11,794.38 MUTL + $1,171.35 SFL + $6,394.53 STDAUTO/FIRE + $25,895.79 AIPP = **$45,256.05 GROSS COMPENSATION** ✅

**This same prototype becomes the live Composio recipe for May 2026 forward.**
The Python pipeline:
```
process_one_recap(recap_meta, message_id, year_folder_id):
  1. GMAIL_GET_ATTACHMENT → /mnt/files/historical_docs/<filename>.pdf
  2. smart_file_extract → OCR text
  3. invoke_llm(PARSER_PROMPT) → returns structured JSON
  4. fix_categorization(line_items) → deterministic DESC_RULES post-processing
  5. upload_local_file → Composio S3 key
  6. GOOGLEDRIVE_UPLOAD_FILE → Drive (2025 or 2026 folder)
  7. Returns (parsed_dict, drive_file_id, local_pdf_path)
```

After process_one_recap returns, a second step writes the documents row + comp_recap rows
linked via `source_document_id`, all in one Supabase transaction.

The parser prompt and DESC_RULES are saved to `docs/SF_COMP_RECAP_PARSER.md` (next commit).

---

## Next actions (in order)

### Immediate (next session)
1. Re-establish workbench parser + DESC_RULES + process_one_recap function
2. Fix Drive placement for Jan 30 and Feb 15 (currently in shared drive root, need to move to SF Comp Recaps folder)
3. Process remaining 22 of 2025 SF Comp Recaps in batches of 2-3 per workbench cell (180s timeout)
4. Process 10 Jan-May 2026 SF Comp Recaps
5. Run reconciliation queries against Dec 30 2025 YTD targets:
   - Federal reportable: $604,051.80
   - MUTL: $341,911.27, SFL: $41,013.64, FIRE+STDAUTO: $220,983.18, IPSI: $38.71, GFA: $105.00

### After comp recaps loaded
6. Post 4 monthly P&L JEs for Jan-April 2026 + Q1 distributions JE ($88,743.17)
7. Build `bank_statement_processor` (BofA Operating, 12 PDFs for 2025 + 5 for 2026)
8. Build `credit_card_processor` (Chase Credit, 12 PDFs for 2025 + 5 for 2026)
9. Register 1099 for 2025 + Articles of Organization in documents (no parsing, just file)

### Recipe rebuild (the rescinded "Rebecca handoff")
10. Convert the 4 proven processors into proper Composio recipes (`automation_recipes` rows with `composio_action=GMAIL_FETCH_EMAILS`)
11. Replace the 6 disabled placeholders with the canonical 12 from `docs/AUTOMATIONS_INSTALL.md`
12. Test each recipe with a fresh email arrival; monitor `automation_run_log` for one cycle

### Module wiring (after data foundation is solid)
13. Seed Tasks & Goals with the agent's annual goals (AIPP target, production goals)
14. Configure Social Media accounts in `social_accounts` (Facebook page, LinkedIn profile)
15. Pre-seed content calendar with first 30 days of compliance-safe content
16. Wire up HR & People with the agent's actual team roster

### Activation
17. Once Vercel deploys, validate every module renders correctly
18. Fix Google Calendar timezone (UTC → ET)
19. Set up Daily Briefing email content properly
20. Declare BCC live to the agent

---

## Reference data — do not lose

- **Composio permanent user:** `pg-test-f05145fc-2c9f-4ded-9f5_kwametylerbusinessclaude`
- **Composio session ID (chat):** `than`
- **BCC Financial Records Drive root:** `1XjQF0vesM3ULaq-PcTqE4XZvJaNU84l6`
- **2025 folder root:** `1ODcXhUwUMoIpajpT34-fiSG1YGVwdDal`
- **SF Compensation Recaps 2025:** `1ZQNCVK7VTX9CgV0Wx1PyVi-8LhzwSvMx`
- **Gmail message ID — 2025 Comp reports:** `19e70384c33fc72d` (24 attachments)
- **Gmail message ID — 2026 Comp reports:** (lookup needed — separate email)
- **Gmail message ID — Tyler Financials:** `19e56132fdc21198`
- **Edge Function ID:** `3eef1585-ab7a-479b-8a0e-4371e2e7b448`
- **Daily Briefing recipe ID:** `1dd052ab-88b9-46b9-97e0-35db07f29098`
- **GL Entry Writer recipe ID:** `a611718d-c685-43ca-9976-7dbc665e5e3f`
- **Monthly Close Monitor recipe ID:** `105e0835-59f3-4d59-8e68-553bf20cc47c`
- **Vercel anon publishable key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlza2FzZmxld3BtanRndHRndXVlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTc5NTUsImV4cCI6MjA5NTQ5Mzk1NX0.M1VyM7rmqJigAYdqeiN8fm3_KFO7IzbUKAUs2XjHnAI`

---

## How to resume

A future Claude session reading this document should:
1. Read all `persistent_memory` entries first (Project Claude system prompt should already do this)
2. Read this file (`docs/INSTALL_STATUS_KWAME_TYLER.md`)
3. Read `docs/SF_COMP_RECAP_PARSER.md` (parser logic for reuse)
4. Check `automation_run_log` for any failed runs since the last session
5. Pick up at the next unchecked action from the "Next actions" section above

Don't start over. Don't re-explain things to the agent that are documented here. This is a
continuous engineering relationship — every session builds on the last.
