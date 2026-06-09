# SF Compensation Recap Parser

**Purpose:** Parse State Farm Agency Compensation Recap PDFs into structured `comp_recap` rows.

**Status:** Proven on Jan 15, 2025 recap. Penny-perfect reconciliation.

This document is the source of truth for the parser logic. Both the workbench-based
historical importer AND the live Composio recipe (post-cutover) use this same logic.

---

## Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│ GMAIL_GET_      │───▶│ smart_file_  │───▶│ invoke_llm with │
│ ATTACHMENT      │    │ extract (OCR)│    │ PARSER_PROMPT   │
└─────────────────┘    └──────────────┘    └─────────────────┘
                                                    │
                                                    ▼
                                          ┌──────────────────┐
                                          │ JSON line_items  │
                                          └──────────────────┘
                                                    │
                                                    ▼
                                       ┌─────────────────────┐
                                       │ fix_categorization  │  ← Python deterministic
                                       │ (DESC_RULES)        │     pattern matching
                                       └─────────────────────┘
                                                    │
                          ┌─────────────────────────┼─────────────────────────┐
                          ▼                         ▼                         ▼
                ┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
                │ GOOGLEDRIVE_    │       │ INSERT into     │       │ INSERT into     │
                │ UPLOAD_FILE     │       │ documents       │       │ comp_recap      │
                │ (year folder)   │       │ (drive_url)     │       │ (2 rows per LI) │
                └─────────────────┘       └─────────────────┘       └─────────────────┘
```

For each line item parsed:
- One row with `amount_type = 'ytd_snapshot'` (the YTD value at the recap date)
- One row with `amount_type = 'half_month_activity'` (the current period value)

The `v_comp_recap_activity` view derives half-month activity from sequential YTD
snapshots when activity isn\'t directly captured.

---

## Parser Prompt (canonical)

Send to `invoke_llm()` with the OCR text appended:

```
You are parsing one State Farm Agency Compensation Recap PDF. OCR\'d from scan — ignore
artifacts ("FOKKER K", "RPRPPRPRP", "HERE", "FREE", "FRRERERE", "ACK", "He AA", "Ck ok",
"RRR EERE"), leading "1"s or "I"s on lines. Numbers and structure are reliable.

3 pages:
- PAGE 1 = PRODUCTION. Each line: DESCRIPTION  CURRENT  YEAR-TO-DATE
- PAGE 2 = PAYMENT. PAYABLE PER AGREEMENT (Per Schedules + AIPP).
  Optional: AWARDS & BONUSES, OTHER INCOME. Two columns.
- PAGE 3 = INFORMATION. Optional: Reportable Benefits. YTD federal/state totals.

RULES:
(1) Lines have 1 or 2 numbers. 2 nums = current then ytd. 1 num = ytd only (current=0).
(2) Trailing minus = negative. "528.47-" is -528.47.
(3) Strip OCR spaces inside numbers: "19 , 360.26" = 19360.26.
(4) Capture EVERY line item including zero or negative.
(5) SKIP aggregate lines: anything starting with "TOTAL ", GROSS COMPENSATION,
    ADJUSTED GROSS, LESS DEDUCTIONS, NET PAYABLE, PER SCHEDULES OF PAYMENT,
    YOUR CHECK FOR, REQUESTED 100%, state-by-state YTD totals at bottom of page 3.
(6) [list of line items to capture — see source]
(7) comp_type best guess (post-processing fixes): MUTL, SFL, STDAUTO, FIRE, IPSI, GFA,
    AIPP, BONUS, OTHER_INCOME, BENEFITS.
(8) comp_category lowercase short name. Best guess.
(9) is_aipp_eligible and is_scoreboard_eligible: best guess, will be overridden.
(10) Period from "RECAPITULATION OF AGENCY COMPENSATION ... FOR <PERIOD>":
   - 1-15 → period_half="first", recap_date = month\'s 15th
   - 16-end → period_half="second", recap_date = last day (28/29 Feb, 30/31 others)
(11) OCR-misread guard for BENEFITS lines (MEDICAL INSURANCE CONTRIBUTION,
    GROUP DENTAL INSURANCE CONTRIBUTION, DENTAL INSURANCE CONTRIBUTION, LIFE
    INSURANCE CONTRIBUTION, AMBASSADOR TRAVEL benefits, INCOME UPDATE benefits):
    a current_amount of 2.00 is almost always a 0.00 OCR misread. Set
    current_amount = 0.00 when (a) the ytd_amount on this line equals the prior
    recap\'s ytd for the same description (the deterministic post-processor
    will verify this), or (b) the apparent current creates an unexplained
    half-month spike that doesn\'t match the YTD delta. When in doubt, output
    2.00 and the post-processor will correct.
(12) AMBASSADOR TRAVEL disambiguation:
    - "AMBASSADOR TRAVEL ALLOWANCE - <PRODUCT>" → BONUS (page 2, Awards & Bonuses)
    - "AMBASSADOR TRAVEL - <PRODUCT>" (no "ALLOWANCE") → BENEFITS (page 3, Reportable Benefits)
    Both can appear in the same recap as separate line items. They are NOT
    duplicates. Section context (page 2 vs page 3) is the tiebreaker if the
    description is otherwise identical after OCR cleanup.

Return ONLY raw JSON: {agent_name, agent_code, territory, period_label, period_year,
period_month, period_half, recap_date, totals{...}, ytd_federal_by_product{...},
line_items[{line_sequence, section, comp_type, comp_category, description,
current_amount, ytd_amount, is_aipp_eligible, is_scoreboard_eligible}]}
```

---

## DESC_RULES (deterministic post-processing)

The LLM categorizes "best guess" — Python then fixes it deterministically based on
description text. **Order matters: most-specific patterns FIRST.** Especially:
- "STD AUTO AIPP PAYMENT" before "AUTO AIPP PAYMENT"
- "AMBASSADOR TRAVEL ALLOWANCE - LIFE" (bonus, page 2) before "AMBASSADOR TRAVEL - LIFE" (benefit, page 3)
- "STD AUTO NEW BUSINESS" before generic "AUTO NEW BUSINESS"

Pattern → (comp_type, comp_category, is_aipp_eligible, is_scoreboard_eligible):

| Description Match (substring, uppercase) | comp_type | comp_category | AIPP? | SB? |
|---|---|---|---|---|
| STD AUTO AIPP PAYMENT | AIPP | std_auto_aipp | false | false |
| AUTO AIPP PAYMENT | AIPP | auto_aipp | false | false |
| HEALTH AIPP PAYMENT | AIPP | health_aipp | false | false |
| FIRE AIPP PAYMENT | AIPP | fire_aipp | false | false |
| LIFE AIPP PAYMENT | AIPP | life_aipp | false | false |
| SCORECARD BONUS - AUTO | BONUS | scorecard_auto | false | false |
| SCORECARD BONUS - FIRE | BONUS | scorecard_fire | false | false |
| SCORECARD BONUS - HEALTH | BONUS | scorecard_health | false | false |
| SCORECARD BONUS - LIFE | BONUS | scorecard_life | false | false |
| CASH AWARD - LIFE | BONUS | cash_award_life | false | false |
| CASH AWARD - AUTO | BONUS | cash_award_auto | false | false |
| AMBASSADOR TRAVEL ALLOWANCE - HEALTH | BONUS | ambassador_travel_health | false | false |
| AMBASSADOR TRAVEL ALLOWANCE - LIFE | BONUS | ambassador_travel_life | false | false |
| AMBASSADOR TRAVEL ALLOWANCE - AUTO | BONUS | ambassador_travel_auto | false | false |
| AMBASSADOR TRAVEL ALLOWANCE - FIRE | BONUS | ambassador_travel_fire | false | false |
| S & T COMPANY CONTRIBUTION - AUTO | OTHER_INCOME | s_t_contribution_auto | false | false |
| S & T COMPANY CONTRIBUTION - FIRE | OTHER_INCOME | s_t_contribution_fire | false | false |
| S & T COMPANY CONTRIBUTION - LIFE | OTHER_INCOME | s_t_contribution_life | false | false |
| S & T COMPANY CONTRIBUTION - HEALTH | OTHER_INCOME | s_t_contribution_health | false | false |
| MARKETING ALLOWANCE | OTHER_INCOME | marketing_allowance | false | false |
| MEDICAL INSURANCE CONTRIBUTION | BENEFITS | medical_insurance | false | false |
| GROUP DENTAL INSURANCE CONTRIBUTION | BENEFITS | dental_insurance | false | false |
| DENTAL INSURANCE CONTRIBUTION | BENEFITS | dental_insurance | false | false |
| LIFE INSURANCE CONTRIBUTION | BENEFITS | life_insurance_benefit | false | false |
| INCOME UPDATE-PREV AWARDED-AUTO | BENEFITS | income_update_auto | false | false |
| INCOME UPDATE-PREV AWARDED-LIFE | BENEFITS | income_update_life | false | false |
| INCOME UPDATE-PREV AWARDED-FIRE | BENEFITS | income_update_fire | false | false |
| INCOME UPDATE-PREV AWARDED-HEALTH | BENEFITS | income_update_health | false | false |
| STD AUTO NEW BUSINESS | STDAUTO | new_business | true | true |
| STD AUTO NEW - AMD66 | STDAUTO | new_amd66 | true | true |
| STD AUTO RENEWAL SERVICE | STDAUTO | renewal_service | true | false |
| STD AUTO RENEWAL - AMD66 | STDAUTO | renewal_amd66 | true | false |
| FIRE NEW BUSINESS | FIRE | new_business | true | true |
| FIRE NEW - AMD66 | FIRE | new_amd66 | true | true |
| FIRE RENEWAL SERVICE | FIRE | renewal_service | true | false |
| FIRE RENEWAL - AMD66 | FIRE | renewal_amd66 | true | false |
| FIRE ALLIANCE RENEWAL | FIRE | alliance_renewal | true | false |
| IPSI PET INSURANCE - RENEW | IPSI | pet_insurance_renewal | false | false |
| IPSI PET INSURANCE | IPSI | pet_insurance_renewal | false | false |
| GFA US BANK CREDIT CARD | GFA | us_bank_credit_card | false | false |
| US BANK CREDIT CARD | GFA | us_bank_credit_card | false | false |
| FIRST YEAR WRITING | SFL | first_year_writing | true | true |
| RENEWAL WRITING | SFL | renewal_writing | true | false |
| AMBASSADOR TRAVEL - HEALTH (page 3 benefit) | BENEFITS | ambassador_travel_health | false | false |
| AMBASSADOR TRAVEL - LIFE | BENEFITS | ambassador_travel_life | false | false |
| AMBASSADOR TRAVEL - AUTO | BENEFITS | ambassador_travel_auto | false | false |
| AMBASSADOR TRAVEL - FIRE | BENEFITS | ambassador_travel_fire | false | false |
| SERVICING | SFL | servicing | true | false |
| HEALTH NEW BUSINESS | MUTL | new_business | true | true |
| HEALTH RENEWAL SERVICE | MUTL | renewal_service | true | false |
| AUTO NEW BUSINESS | MUTL | new_business | true | true |
| AUTO NEW - AMD66 | MUTL | new_amd66 | true | true |
| AUTO RENEWAL SERVICE | MUTL | renewal_service | true | false |
| AUTO RENEWAL - AMD66 | MUTL | renewal_amd66 | true | false |

---

## Year-over-year evolutions (parser canon updates)

The parser canon is updated whenever a previously-unseen line description appears
in production SF recaps. Every new pattern lives in DESC_RULES; every new content
quirk (OCR drift, missing column, etc.) lives in the PARSER_PROMPT RULES.

**Discoveries logged during the 2025 historical backfill (closed 2026-06-08):**

1. **AMBASSADOR TRAVEL benefits variants (page 3).** A 2025-09-30 recap first
   surfaced "AMBASSADOR TRAVEL - HEALTH" ($963.20 YTD) and "AMBASSADOR TRAVEL -
   LIFE" ($11,452.35 YTD) in the page-3 Reportable Benefits section, distinct
   from the page-2 "AMBASSADOR TRAVEL ALLOWANCE - <product>" BONUS lines. Both
   sets can coexist in the same recap. Disambiguation is now PARSER_PROMPT
   rule (12) and the DESC_RULES table has explicit rows for both.

2. **IPSI PET INSURANCE - RENEW (page 1).** A 2025-10-31 recap first surfaced
   the explicit RENEW suffix on the IPSI pet insurance line (cur=ytd=$38.63,
   frozen through year-end). DESC_RULES now matches the suffixed variant first
   (most-specific) and falls back to the base "IPSI PET INSURANCE" pattern.

3. **OCR 2.00-for-0.00 misread on BENEFITS lines.** A 2025-03-15 recap had
   MEDICAL/DENTAL/LIFE INSURANCE CONTRIBUTION rows all reading "2.00" current
   when the YTD was unchanged from the prior recap (Feb 28). Verified by
   YTD-equals-prior-recap-YTD rule that the correct current was 0.00. Now
   handled by PARSER_PROMPT rule (11) + deterministic post-processor (the
   post-processor compares each BENEFITS line\'s ytd_amount to the prior
   recap\'s YTD for the same description; if equal, current is forced to 0.00).

**How to log a future discovery:** add the new DESC_RULES row (most-specific
first), update the PARSER_PROMPT RULES if a new content rule is needed, and
append a short bullet to this section with the recap_date that first surfaced
the pattern.

---

## Database insertion pattern

For each parsed line item, insert TWO rows into `comp_recap`:

```sql
INSERT INTO comp_recap (
  agency_id, period_year, period_month, period_half, recap_date, line_sequence,
  comp_type, comp_category, description, amount, amount_type,
  is_aipp_eligible, is_scoreboard_eligible, source_document_id, posted_at, created_at
) VALUES
-- YTD snapshot row
('<agency_id>', <year>, <month>, '<half>', '<recap_date>', <seq>,
 '<comp_type>', '<comp_category>', '<description>', <ytd_amount>, 'ytd_snapshot',
 <is_aipp>, <is_sb>, '<document_id>', NOW(), NOW()),
-- Half-month activity row
('<agency_id>', <year>, <month>, '<half>', '<recap_date>', <seq>,
 '<comp_type>', '<comp_category>', '<description>', <current_amount>, 'half_month_activity',
 <is_aipp>, <is_sb>, '<document_id>', NOW(), NOW());
```

Unique constraint: `(agency_id, recap_date, comp_type, comp_category, description, amount_type)`
ensures idempotent re-runs and prevents duplicate inserts.

`posted_at = NOW()` flags pre-cutover historical rows so the live GL Writer recipe skips them
(GL Writer respects `settings.gl_cutover_date`).

---

## Validation queries

After loading all 2025 recaps (24 PDFs), these should match the recap source-of-truth:

```sql
-- Federal reportable YTD across all 2025 (should = $604,051.80)
SELECT SUM(amount) FROM comp_recap
WHERE agency_id = \'<agency>\' AND amount_type = \'half_month_activity\'
  AND period_year = 2025;

-- By product family (should match Dec 30 2025 YTD by product)
SELECT comp_type, SUM(amount) FROM comp_recap
WHERE agency_id = \'<agency>\' AND amount_type = \'half_month_activity\'
  AND period_year = 2025
GROUP BY comp_type;
-- Expected: MUTL $341,911.27, SFL $41,013.64, STDAUTO+FIRE $220,983.18, IPSI $38.71, GFA $105.00

-- Period-over-period analysis (e.g. May 15 2025 vs May 15 2026)
SELECT comp_type, comp_category, description, amount FROM comp_recap
WHERE agency_id = \'<agency>\' AND amount_type = \'half_month_activity\'
  AND period_month = 5 AND period_half = \'first\'
ORDER BY recap_date, line_sequence;

-- Cancellation/clawback isolation (negative amounts)
SELECT recap_date, comp_type, comp_category, description, amount FROM comp_recap
WHERE agency_id = \'<agency>\' AND amount_type = \'half_month_activity\'
  AND amount < 0
ORDER BY recap_date, amount;
```

---

## Live recipe wrapping (post-cutover)

To convert this from a workbench script into a live Composio recipe:

```sql
INSERT INTO automation_recipes (
  agency_id, recipe_name, recipe_type, composio_action, composio_connection,
  cron_expression, input_config, groq_prompt, output_table, output_config,
  is_active, ...
) VALUES (
  \'<agency_id>\',
  \'SF Daily Comp Processor\',
  \'document_processor\',
  \'GMAIL_FETCH_EMAILS\',
  \'gmail\',
  \'7,37 * * * *\',  -- every 30 min
  \'{"query": "from:statefarm.com subject:(compensation OR recap) has:attachment newer_than:7d", "max_results": 5}\',
  -- groq_prompt = the PARSER_PROMPT above
  \'<full parser prompt>\',
  \'comp_recap\',
  \'{"unique_on": ["agency_id", "recap_date", "comp_type", "comp_category", "description", "amount_type"], "on_conflict": "ignore"}\',
  true,
  ...
);
```

The Edge Function `automation-runner` will:
1. Fetch matching Gmail messages
2. Pass each attachment through the parser prompt via `COMPOSIO_SEARCH_GROQ_CHAT`
3. Apply DESC_RULES post-processing (need to add this to the runner OR run it as an INTERNAL recipe phase)
4. Write to `comp_recap` table
5. File the PDF in Drive
6. Log to `automation_run_log`

**Open question for build:** the runner currently doesn\'t do deterministic post-processing
between the LLM call and the DB insert. For high accuracy on the categorization, we need
either:
- (a) A second-pass INTERNAL recipe that fixes categorization after raw LLM output is inserted
- (b) An extension to the runner to support a `post_process` Python expression / SQL function
- (c) A SQL trigger on `comp_recap` that runs the DESC_RULES on INSERT

Option (c) is probably cleanest: write the DESC_RULES as a PL/pgSQL function, install as
a `BEFORE INSERT` trigger on `comp_recap`. Then the runner can dump raw LLM output and the
trigger normalizes it. To be implemented when wrapping the processor as a recipe.
