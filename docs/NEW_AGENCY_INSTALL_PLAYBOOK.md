# NEW AGENCY BCC — Install Playbook

**Audience:** Imaginary Farms LLC installer (you, the resident Claude for the new agent) standing up a fresh BCC for a new SF agency.

**Outcome:** A working agency BCC with the new GL pipeline (post-2026-06-10 architecture) — chart of accounts seeded by line of business, comp recap routed via the mapping table, gl_entry_writer posting one JE per recap_date, benefits handled as a P&L wash, all cutover-aware.

**Time:** 60-90 minutes of attended work, then overnight wait for first cron run.

---

## Pre-flight checklist

Before touching anything, confirm you have:

- [ ] A Supabase project created for the new agency (note the project ref and a service-role connection)
- [ ] A GitHub fork of `Tylerbccdashboard` for the new agent (Vercel deploy will hang off this)
- [ ] A Composio user/account with these connections active: Gmail, Drive, Calendar, Docs, Supabase, GitHub
- [ ] The new agency's UUID picked. Generate one once with `SELECT gen_random_uuid();` and write it down — you'll paste it into every seed file.
- [ ] The new agency's GL cutover date agreed with the agent (recommended: end of the last month their CPA closed)
- [ ] The new agency's opening balance sheet from their CPA (for the OB-YYYY-MM-DD JE)

If any box is unchecked, stop and resolve. Do not skip the cutover date — that one decision controls everything downstream.

---

## Step 1 — Apply migrations in order

In the new Supabase project's SQL editor (or via psql), apply `supabase/migrations/*.sql` in numeric order: **001 → 014**. Every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING` on seed data).

**Important:** Don't stop at 013. Migration 014 is the chargeback / signed-amount fix to `gl_entry_writer` — without it, the very first post-cutover comp_recap row with a negative amount (cancellation, NSF, AMD66 retro) will fail the `debit_credit_check` constraint on `journal_lines` and the whole cron run rolls back. This bug bit Kwame's agency on the first live cron run (2026-06-11 16:00 UTC) before 014 was applied. Don't repeat it.

Verify after the run:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' ORDER BY table_name;
-- Expect: agency, alerts, applicants, automation_recipes, automation_run_log,
-- bank_transactions, chart_of_accounts, comp_recap, comp_recap_account_mapping,
-- compliance_calendar, compliance_log, compliance_rules, content_calendar,
-- credit_transactions, documents, goals, journal_entries, journal_lines,
-- monthly_close_checklist, onboarding_checklists, payroll_detail, payroll_runs,
-- persistent_memory, producer_production, settings, social_accounts,
-- staff, staff_performance, tasks, ... (plus a few extras)

SELECT proname FROM pg_proc WHERE pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')
  AND proname IN ('gl_entry_writer', 'payroll_gl_writer', 'bank_gl_writer', 'credit_card_gl_writer',
                  'monthly_close_monitor', 'monthly_close_checklist_generator', 'producer_underperformance_watcher');
-- Expect 7 functions.
```

If 013 fails because 012 didn't run first, stop and check migration ordering. Apply them strictly in number order.

---

## Step 2 — Seed agency-specific data

Substitute the new agency's UUID into every seed. The seeds that need attention:

### 2a. Agency row

```sql
INSERT INTO public.agency (id, name, entity_type, ein, ...)
VALUES ('<NEW_AGENCY_UUID>', 'Their Agency Name LLC', 's-corp', '00-0000000', ...);
```

Get the full column list from `supabase/migrations/004_seed_agency_record.sql` and fill in real values from the agent intake.

### 2b. Cutover policy and base settings

```sql
INSERT INTO public.settings (agency_id, setting_key, setting_value, setting_type, updated_by) VALUES
  ('<NEW_AGENCY_UUID>', 'gl_cutover_date',                  '<YYYY-MM-DD>',              'date',   'install'),
  ('<NEW_AGENCY_UUID>', 'gl_default_cash_account_name',     'Operating Checking Account','text',   'install'),
  ('<NEW_AGENCY_UUID>', 'gl_default_sf_revenue_account_name','Miscellaneous Income',      'text',   'install'),
  ('<NEW_AGENCY_UUID>', 'fiscal_year_end',                  '12-31',                     'text',   'install');
```

**`gl_cutover_date` semantics (CRITICAL):** the cutover date is **inclusive on the pre-cutover side**. `gl_entry_writer` filters `recap_date > cutover`. So a cutover of `2026-04-30` means 4/30 stays archive-only (never posts to JE) and 5/15 and later post. Set this to the last day of the last month the CPA has closed.

### 2c. Chart of accounts

Apply `supabase/migrations/003_seed_chart_of_accounts.sql` substituting the new agency_id. That gives you the 145 SF-standard accounts.

Then apply `supabase/recipe_seeds/14_gl_account_mapping_TEMPLATE.sql` with `{{agency_id}}` replaced — this adds the 10 line-of-business income / expense accounts and the 21 comp_recap routing rules.

### 2d. Compliance + producers

- Apply `002_seed_compliance_rules.sql` — 76 SF compliance rules (agency-agnostic, just needs the agency_id substituted).
- Apply `010_producer_roi_infrastructure.sql` for Performance tab support.
- Set `agency.smvc_rate_pc` (typically 10%), `agency.blended_rate` (8-10%), `agency.lapse_rate_annual` (typically 8-12%). Confirm these with the agent.

### 2e. Recipe instances

Apply `supabase/recipe_seeds/01_*.sql` through `13_*.sql` (and the new `14_gl_account_mapping_TEMPLATE.sql`), substituting `{{agency_id}}` everywhere. This creates the 13 canonical recipes in `automation_recipes`.

Verify:

```sql
SELECT name, schedule, is_active, internal_handler, composio_tool
FROM automation_recipes WHERE agency_id='<NEW_AGENCY_UUID>'
ORDER BY name;
-- Expect 13 rows.
```

---

## Step 3 — Composio connection wiring

The Edge Function `automation-runner` reads `COMPOSIO_API_KEY` from the Supabase Edge Function Secrets env. Set it:

```bash
supabase secrets set COMPOSIO_API_KEY=<the_new_composio_user_api_key>
```

Then confirm pg_cron is firing and the runner is reachable:

```sql
SELECT * FROM cron.job WHERE jobname LIKE 'automation%' ORDER BY jobname;
-- Expect a tick that fires every minute.

SELECT * FROM public.automation_run_log
WHERE agency_id='<NEW_AGENCY_UUID>'
ORDER BY started_at DESC LIMIT 10;
-- Should populate within 1-2 minutes of any active recipe matching a schedule slot.
```

Composio tokens for Gmail / Drive / Calendar tend to expire every ~30 days. If a run log shows `failed` with an OAuth error, generate a reauth link in the Composio dashboard and have the agent click it. See `docs/SELF_HEAL_GUIDE.md`.

---

## Step 4 — Pre-cutover historical archive

Everything dated **on or before** the cutover date is loaded as **archive-only**. The data lives in `comp_recap` (and eventually `bank_transactions`, `credit_transactions`, `payroll_runs`), but `posted_at` is set to `NOW()` immediately so the GL writers never touch it. The CPA's opening balance sheet at the cutover date is the authoritative starting point for the GL.

Workflow:

1. Use the SF Comp Recap parser pipeline (`docs/SF_COMP_RECAP_PARSER.md`) to load every historical SF Comp Recap into `comp_recap`.
2. Reconcile each recap's `ytd_snapshot` sum to the recap's own "Federal YTD" total — penny-perfect or fix the parse.
3. After load, mark all rows as posted so the GL writer skips them:

```sql
UPDATE public.comp_recap
SET posted_at = NOW(), journal_entry_id = NULL  -- NULL because no JE exists for archive rows
WHERE agency_id='<NEW_AGENCY_UUID>' AND posted_at IS NULL;
```

4. Post one opening-balance JE dated at the cutover date, reflecting the CPA's balance sheet exactly. Reference number convention: `OB-YYYY-MM-DD`. Source: `cpa_handoff`.

---

## Step 5 — Arm the first post-cutover recap

The first SF Comp Recap dated AFTER the cutover date is the live test of the pipeline. Don't simulate it — wait for the real one to arrive (usually 5-7 business days after the half-month close).

When it lands:

1. The Document Processor recipe picks it up from Gmail, classifies it, files it to Drive.
2. The SF Comp Recap parser converts the PDF to `comp_recap` rows with `posted_at IS NULL`.
3. Next 16:00 UTC, `gl_entry_writer` cron sweeps those rows:
   - Creates ONE `journal_entries` header per recap_date with `reference_number = 'SFCR-YYYY-MM-DD'`
   - For each non-zero `amount_type='half_month_activity'` row: looks up the mapping in `comp_recap_account_mapping`, inserts 2 `journal_lines` (DR cash + CR income; or DR 6120 + CR 4180 for benefits wash)
   - Sets `comp_recap.posted_at = NOW()` and `comp_recap.journal_entry_id = <new JE id>` per row
   - Sweeps `ytd_snapshot` rows (no JE — reconciliation snapshots only) to posted

Verify the next day:

```sql
SELECT
  je.entry_date,
  je.reference_number,
  je.memo,
  (SELECT SUM(debit)  FROM journal_lines WHERE journal_entry_id=je.id) AS dr_total,
  (SELECT SUM(credit) FROM journal_lines WHERE journal_entry_id=je.id) AS cr_total,
  (SELECT COUNT(*)    FROM journal_lines WHERE journal_entry_id=je.id) AS line_count
FROM journal_entries je
WHERE agency_id='<NEW_AGENCY_UUID>' AND source='gl_entry_writer'
ORDER BY entry_date DESC LIMIT 5;
```

Expect: `dr_total = cr_total` (entry balances), `line_count ≥ 2`, `memo` showing the cash deposit total.

If `automation_run_log.records_processed = 0`: either the recap_date is on/before the cutover (check the date filter), or the rows have `posted_at` already populated (re-check the parser), or `gl_default_cash_account_name` points at a non-existent account (run the smoke test at the bottom of `recipe_seeds/14_gl_account_mapping_TEMPLATE.sql`).

---

## Step 6 — Persistent memory + Project Claude

Populate `persistent_memory` for the new agency under these categories (use Kwame's agency as a model — `SELECT * FROM persistent_memory WHERE agency_id='98aa8b9b-92e4-4ebc-8727-aa00ce696fab';`):

- `agency_profile` — name, entity type, owner, EIN, locations, license states, office staff structure
- `business_rules` — agency-specific accounting policy (cash basis, owner draw vs S-corp distribution treatment) and SF compliance rules
- `operational_rules` — GL cutover policy with the chosen date, repo conventions, who is the engineer (Claude or someone else)
- `financial_context` — S-Corp reasonable comp baseline, AIPP target, ScoreBoard targets, blended rate, lapse rate
- `key_contacts` — CPA, bookkeeper, legal counsel, key vendors

Set up the agent's Project Claude system prompt by copying `docs/PROJECT_CLAUDE_SYSTEM_PROMPT_TEMPLATE.md` and substituting the new agency name, UUID, Supabase URL, GitHub repo, and any agency-specific feature toggles. The agent will paste this as their Project's custom instructions.

---

## Step 7 — Vercel + first deploy

In the new GitHub fork, set up Vercel:

1. Connect the repo
2. Set env vars:
   - `VITE_SUPABASE_URL` = `https://<new-project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = the new project's anon key (Supabase → Settings → API)
   - `VITE_AGENCY_ID` = the new agency's UUID
   - `VITE_USE_MOCK_DATA` = `false`
3. Trigger a deploy. Vercel auto-deploys on every commit to main; first deploy takes ~90 seconds.
4. Open the deployed URL. Every module should render. Empty modules (Bank, Credit, Payroll, Tasks, Goals, Social) are expected at install time.

---

## Step 8 — Acceptance criteria

Declare the install live when ALL of these are true:

- [ ] All 13 recipes show `is_active=true` and have logged at least one successful run in `automation_run_log`
- [ ] First post-cutover SF Comp Recap has been processed end-to-end (Gmail → comp_recap → journal_entries) without manual intervention
- [ ] Federal YTD on the last loaded comp_recap matches the recap's reported figure to the penny
- [ ] Daily Briefing email has arrived in the agent's inbox at least once
- [ ] All five Persistent Memory categories above have at least one row populated
- [ ] Compliance Center shows 76 rules; Compliance Calendar shows annual/monthly deadlines
- [ ] Producer Performance tab loads (even if empty — schema is there)
- [ ] No `automation_run_log` entries with `status='failed'` in the last 24h

---

## Common pitfalls

| Symptom | Root cause | Fix |
|---|---|---|
| `gl_entry_writer` returns `records_processed=0` despite unposted recaps | Cutover date filter — `recap_date > cutover` is exclusive on the cutover day | Verify `recap_date > gl_cutover_date` matches the recaps you expect |
| `gl_entry_writer` errors with `debit_credit_check` constraint violation | Migration 014 was skipped — function isn't flipping DR/CR sides on negative amounts | Apply migration 014. The function uses `ABS(amount)` and flips sides for chargebacks. |
| `gl_entry_writer` posts everything to "Miscellaneous Income" | No matching rule in `comp_recap_account_mapping` for that `comp_type` | Add the missing rule with the correct `credit_account_code` |
| JE created but no `journal_lines` | Lines couldn't resolve a debit or credit account (`v_debit_acct_id IS NULL`) | The empty JE is auto-deleted; root cause is usually a `credit_account_code` in the mapping that doesn't exist in `chart_of_accounts`. Run the smoke test in recipe seed 14. |
| YTD double-counted in revenue | Earlier `gl_entry_writer` was processing `ytd_snapshot` rows too | Confirm migration 013 was applied — the new function filters `amount_type='half_month_activity'` |
| Benefits showing as cash receipts on the bank rec | Benefits routed to a cash account instead of the wash | Confirm BENEFITS rule has `is_benefit_wash=true` and `debit_account_code='6120'` |
| BCC web app shows blank screens | RLS lockdown — anon role missing GRANTs | Re-run migration 005 (`005_anon_read_policies.sql`) |
| Vite build silently drops modules | Comment before line-1 imports | Ensure every `.jsx` module starts with `import` on line 1 |

---

## Related reading

- `docs/AUTOMATIONS_INSTALL.md` — full recipe templates and runner setup
- `docs/DOCUMENT_IMPORTER_GUIDE.md` — Document Processor recipe behavior
- `docs/SF_COMP_RECAP_PARSER.md` — parser logic for SF Comp Recap PDFs
- `docs/MODULE_DATA_WIRING.md` — per-module data-source reference
- `docs/PRODUCER_ROI_INSTALL.md` — Performance tab onboarding
- `docs/SELF_HEAL_GUIDE.md` — what to do when a connector token expires
- `docs/PROJECT_CLAUDE_SYSTEM_PROMPT_TEMPLATE.md` — system prompt the agent pastes into their Project
- `supabase/migrations/013_gl_entry_writer_post_cutover_redesign.sql` — the schema + function this playbook depends on
- `supabase/migrations/014_gl_entry_writer_signed_amount_fix.sql` — chargeback / negative-amount handling fix (DO NOT SKIP)
- `supabase/recipe_seeds/14_gl_account_mapping_TEMPLATE.sql` — the per-agency seed this playbook applies

---

*Last updated: 2026-06-11. If you change the GL pipeline architecture, update this playbook in the same commit.*
