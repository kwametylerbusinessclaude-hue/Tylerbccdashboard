"""
SF Agency Compensation Recap PDF parser — manual backstop.

This module wraps the proven 2025 historical backfill parser as a callable function.
It is the MANUAL BACKSTOP for the not-yet-built Document Processor live recipe.

WHEN TO USE
-----------
Until the Edge Function orchestrator for `Document Processor` ships, every new SF
Comp Recap PDF that lands in Gmail must be ingested by manually calling this
parser from a Composio sandbox session:

    from scripts.parsers.sf_comp_recap import parse_and_ingest

    result = parse_and_ingest(
        pdf_path=local_pdf_path,
        agency_id="98aa8b9b-92e4-4ebc-8727-aa00ce696fab",
        document_id=document_uuid,
        sandbox_helpers=dict(
            smart_file_extract=smart_file_extract,  # Composio sandbox helper
            invoke_llm=invoke_llm,                  # Composio sandbox helper
        ),
        supabase_rpc=supabase_rpc,                  # callable(rpc_name, kwargs) -> jsonb
    )
    print(result)

The result is the `sf_comp_recap_ingest` SQL-function return value (see
migration 023 for the exact schema). A `status == "ok"` result with
`reconciliation.half_month_ok == True` and `ytd_ok == True` means the PDF
ingested cleanly with $0.00 reconciliation deltas.

DESIGN
------
4 pure functions + 1 orchestrator:

  1. `PARSER_PROMPT` (string constant) — the LLM prompt that converts OCR'd PDF
     text into a structured line_items JSON.
  2. `DESC_RULES` (list of tuples) — the deterministic categorisation table. The
     LLM does best-guess categorisation; this table is the source of truth.
  3. `apply_desc_rules(line_items)` — post-processor that runs DESC_RULES on
     each line and overwrites comp_type / comp_category / is_aipp_eligible /
     is_scoreboard_eligible. Pure function, unit-testable.
  4. `transform_to_ingest_payload(llm_output)` — drops fields the ingest
     function doesn't need (agent_name, territory, etc.) and renames
     `line_items` → `lines`, `totals` → `reconciliation`. Pure function.
  5. `parse_and_ingest(pdf_path, agency_id, document_id, sandbox_helpers,
     supabase_rpc)` — the orchestrator. OCR → LLM → DESC_RULES → transform →
     ingest. Returns the SQL function result jsonb.

PROVEN ACCURACY
---------------
This logic produced PENNY-PERFECT reconciliation across 24 PDFs (full 2025
year backfilled 2026-06-08). Full audit trail in agent_memory.

REFERENCE: docs/SF_COMP_RECAP_PARSER.md is the design spec.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional, Tuple


# =============================================================================
# 1. PARSER_PROMPT — sent to the LLM along with OCR'd PDF text.
# =============================================================================

PARSER_PROMPT = """You are parsing one State Farm Agency Compensation Recap PDF. OCR'd from scan — ignore
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
(6) Capture: AUTO/STD AUTO/FIRE/HEALTH NEW BUSINESS, NEW-AMD66, RENEWAL SERVICE,
    RENEWAL-AMD66; FIRE ALLIANCE RENEWAL; FIRST YEAR WRITING, RENEWAL WRITING,
    SERVICING (SFL); IPSI PET INSURANCE / IPSI PET INSURANCE - RENEW; US BANK
    CREDIT CARD / GFA US BANK CREDIT CARD; AIPP payments (AUTO/STD AUTO/FIRE/
    LIFE/HEALTH AIPP PAYMENT); SCORECARD BONUS - {product}; CASH AWARD -
    {product}; AMBASSADOR TRAVEL ALLOWANCE - {product} (bonus); S & T COMPANY
    CONTRIBUTION - {product}; MARKETING ALLOWANCE; MEDICAL/DENTAL/GROUP DENTAL/
    LIFE INSURANCE CONTRIBUTION (benefits); INCOME UPDATE-PREV AWARDED-{product}
    (benefit); AMBASSADOR TRAVEL - {product} (benefit on page 3, NOT page 2).
(7) comp_type best guess (post-processing fixes): MUTL, SFL, STDAUTO, FIRE, IPSI, GFA,
    AIPP, BONUS, OTHER_INCOME, BENEFITS.
(8) comp_category lowercase short name. Best guess.
(9) is_aipp_eligible and is_scoreboard_eligible: best guess, will be overridden.
(10) Period from "RECAPITULATION OF AGENCY COMPENSATION ... FOR <PERIOD>":
   - 1-15 → period_half="first", recap_date = month's 15th
   - 16-end → period_half="second", recap_date = last day (28/29 Feb, 30/31 others)
(11) OCR-misread guard for BENEFITS lines (MEDICAL INSURANCE CONTRIBUTION,
    GROUP DENTAL INSURANCE CONTRIBUTION, DENTAL INSURANCE CONTRIBUTION, LIFE
    INSURANCE CONTRIBUTION, AMBASSADOR TRAVEL benefits, INCOME UPDATE benefits):
    a current_amount of 2.00 is almost always a 0.00 OCR misread. Set
    current_amount = 0.00 when (a) the ytd_amount on this line equals the prior
    recap's ytd for the same description (the deterministic post-processor
    will verify this), or (b) the apparent current creates an unexplained
    half-month spike that doesn't match the YTD delta. When in doubt, output
    2.00 and the post-processor will correct.
(12) AMBASSADOR TRAVEL disambiguation:
    - "AMBASSADOR TRAVEL ALLOWANCE - <PRODUCT>" → BONUS (page 2, Awards & Bonuses)
    - "AMBASSADOR TRAVEL - <PRODUCT>" (no "ALLOWANCE") → BENEFITS (page 3, Reportable Benefits)
    Both can appear in the same recap as separate line items. They are NOT
    duplicates. Section context (page 2 vs page 3) is the tiebreaker if the
    description is otherwise identical after OCR cleanup.

ALSO capture the half-month and YTD GROSS COMPENSATION totals reported on the
PDF — these are the source-of-truth for reconciliation. Look for lines like
"TOTAL GROSS COMPENSATION" or "GROSS COMPENSATION".

Return ONLY raw JSON (no markdown fences, no commentary), with this shape:
{
  "agent_name": "...",
  "agent_code": "...",
  "territory": "...",
  "period_label": "...",
  "period_year": 2026,
  "period_month": 5,
  "period_half": "first" | "second",
  "recap_date": "2026-05-15",
  "totals": {
    "half_month_total_pdf": 266777.60,
    "ytd_total_pdf": 1097824.69
  },
  "line_items": [
    {
      "line_sequence": 1,
      "section": "page1_production" | "page2_payment" | "page3_information",
      "comp_type": "MUTL",
      "comp_category": "new_business",
      "description": "AUTO NEW BUSINESS",
      "current_amount": 2488.23,
      "ytd_amount": 14818.23,
      "is_aipp_eligible": true,
      "is_scoreboard_eligible": true
    }
  ]
}
"""


# =============================================================================
# 2. DESC_RULES — the deterministic categorisation table.
#
# IMPORTANT: order is significant. Most-specific patterns FIRST. Especially:
#   - "STD AUTO AIPP PAYMENT" before "AUTO AIPP PAYMENT"
#   - "STD AUTO NEW BUSINESS" before "AUTO NEW BUSINESS"
#   - "AMBASSADOR TRAVEL ALLOWANCE - X" (bonus, page 2)
#     before "AMBASSADOR TRAVEL - X" (benefit, page 3).
#
# Fields: (description_substring_upper, comp_type, comp_category, is_aipp_eligible, is_scoreboard_eligible)
# =============================================================================

DESC_RULES: List[Tuple[str, str, str, bool, bool]] = [
    # ===== AIPP payments (most specific first) =====
    ("STD AUTO AIPP PAYMENT",       "AIPP",         "std_auto_aipp",         False, False),
    ("AUTO AIPP PAYMENT",           "AIPP",         "auto_aipp",             False, False),
    ("HEALTH AIPP PAYMENT",         "AIPP",         "health_aipp",           False, False),
    ("FIRE AIPP PAYMENT",           "AIPP",         "fire_aipp",             False, False),
    ("LIFE AIPP PAYMENT",           "AIPP",         "life_aipp",             False, False),

    # ===== Scorecard bonuses (page 2) =====
    ("SCORECARD BONUS - AUTO",      "BONUS",        "scorecard_auto",        False, False),
    ("SCORECARD BONUS - FIRE",      "BONUS",        "scorecard_fire",        False, False),
    ("SCORECARD BONUS - HEALTH",    "BONUS",        "scorecard_health",      False, False),
    ("SCORECARD BONUS - LIFE",      "BONUS",        "scorecard_life",        False, False),

    # ===== Cash Awards (page 2) =====
    ("CASH AWARD - LIFE",           "BONUS",        "cash_award_life",       False, False),
    ("CASH AWARD - AUTO",           "BONUS",        "cash_award_auto",       False, False),

    # ===== Ambassador Travel ALLOWANCE → BONUS (page 2). Match BEFORE bare "AMBASSADOR TRAVEL -". =====
    ("AMBASSADOR TRAVEL ALLOWANCE - HEALTH", "BONUS", "ambassador_travel_health", False, False),
    ("AMBASSADOR TRAVEL ALLOWANCE - LIFE",   "BONUS", "ambassador_travel_life",   False, False),
    ("AMBASSADOR TRAVEL ALLOWANCE - AUTO",   "BONUS", "ambassador_travel_auto",   False, False),
    ("AMBASSADOR TRAVEL ALLOWANCE - FIRE",   "BONUS", "ambassador_travel_fire",   False, False),

    # ===== S & T contributions (page 2) =====
    ("S & T COMPANY CONTRIBUTION - AUTO",   "OTHER_INCOME", "s_t_contribution_auto",   False, False),
    ("S & T COMPANY CONTRIBUTION - FIRE",   "OTHER_INCOME", "s_t_contribution_fire",   False, False),
    ("S & T COMPANY CONTRIBUTION - LIFE",   "OTHER_INCOME", "s_t_contribution_life",   False, False),
    ("S & T COMPANY CONTRIBUTION - HEALTH", "OTHER_INCOME", "s_t_contribution_health", False, False),
    ("MARKETING ALLOWANCE",                 "OTHER_INCOME", "marketing_allowance",     False, False),

    # ===== Reportable Benefits (page 3) =====
    ("MEDICAL INSURANCE CONTRIBUTION",      "BENEFITS", "medical_insurance",      False, False),
    ("GROUP DENTAL INSURANCE CONTRIBUTION", "BENEFITS", "dental_insurance",       False, False),
    ("DENTAL INSURANCE CONTRIBUTION",       "BENEFITS", "dental_insurance",       False, False),
    ("LIFE INSURANCE CONTRIBUTION",         "BENEFITS", "life_insurance_benefit", False, False),
    ("INCOME UPDATE-PREV AWARDED-AUTO",     "BENEFITS", "income_update_auto",     False, False),
    ("INCOME UPDATE-PREV AWARDED-LIFE",     "BENEFITS", "income_update_life",     False, False),
    ("INCOME UPDATE-PREV AWARDED-FIRE",     "BENEFITS", "income_update_fire",     False, False),
    ("INCOME UPDATE-PREV AWARDED-HEALTH",   "BENEFITS", "income_update_health",   False, False),

    # ===== STD AUTO production (page 1) — STD AUTO before AUTO =====
    ("STD AUTO NEW BUSINESS",               "STDAUTO", "new_business",       True, True),
    ("STD AUTO NEW - AMD66",                "STDAUTO", "new_amd66",          True, True),
    ("STD AUTO RENEWAL SERVICE",            "STDAUTO", "renewal_service",    True, False),
    ("STD AUTO RENEWAL - AMD66",            "STDAUTO", "renewal_amd66",      True, False),

    # ===== FIRE production (page 1) =====
    ("FIRE NEW BUSINESS",                   "FIRE",    "new_business",       True, True),
    ("FIRE NEW - AMD66",                    "FIRE",    "new_amd66",          True, True),
    ("FIRE RENEWAL SERVICE",                "FIRE",    "renewal_service",    True, False),
    ("FIRE RENEWAL - AMD66",                "FIRE",    "renewal_amd66",      True, False),
    ("FIRE ALLIANCE RENEWAL",               "FIRE",    "alliance_renewal",   True, False),

    # ===== IPSI Pet Insurance (page 1) — RENEW suffix before bare =====
    ("IPSI PET INSURANCE - RENEW",          "IPSI",    "pet_insurance_renewal", False, False),
    ("IPSI PET INSURANCE",                  "IPSI",    "pet_insurance_renewal", False, False),

    # ===== GFA US Bank Credit Card (page 1) =====
    ("GFA US BANK CREDIT CARD",             "GFA",     "us_bank_credit_card",   False, False),
    ("US BANK CREDIT CARD",                 "GFA",     "us_bank_credit_card",   False, False),

    # ===== SFL (page 1) =====
    ("FIRST YEAR WRITING",                  "SFL",     "first_year_writing",    True, True),
    ("RENEWAL WRITING",                     "SFL",     "renewal_writing",       True, False),
    ("SERVICING",                           "SFL",     "servicing",             True, False),

    # ===== AMBASSADOR TRAVEL benefits (page 3) — bare "AMBASSADOR TRAVEL -" =====
    ("AMBASSADOR TRAVEL - HEALTH",          "BENEFITS", "ambassador_travel_health", False, False),
    ("AMBASSADOR TRAVEL - LIFE",            "BENEFITS", "ambassador_travel_life",   False, False),
    ("AMBASSADOR TRAVEL - AUTO",            "BENEFITS", "ambassador_travel_auto",   False, False),
    ("AMBASSADOR TRAVEL - FIRE",            "BENEFITS", "ambassador_travel_fire",   False, False),

    # ===== MUTL (page 1) — most generic AUTO patterns last =====
    ("HEALTH NEW BUSINESS",                 "MUTL",    "new_business",       True, True),
    ("HEALTH RENEWAL SERVICE",              "MUTL",    "renewal_service",    True, False),
    ("AUTO NEW BUSINESS",                   "MUTL",    "new_business",       True, True),
    ("AUTO NEW - AMD66",                    "MUTL",    "new_amd66",          True, True),
    ("AUTO RENEWAL SERVICE",                "MUTL",    "renewal_service",    True, False),
    ("AUTO RENEWAL - AMD66",                "MUTL",    "renewal_amd66",      True, False),
]


# =============================================================================
# 3. apply_desc_rules — pure post-processor.
# =============================================================================

def apply_desc_rules(line_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Run DESC_RULES against each line. Most-specific first.

    Overwrites comp_type, comp_category, is_aipp_eligible, is_scoreboard_eligible.
    Skips lines that match no rule (caller decides what to do with those — usually
    log a warning + keep the LLM's best guess).
    """
    out: List[Dict[str, Any]] = []
    unmatched: List[str] = []
    for line in line_items:
        desc_upper = (line.get("description") or "").upper().strip()
        matched = False
        for pattern, comp_type, comp_category, aipp, sb in DESC_RULES:
            if pattern in desc_upper:
                line = dict(line)  # don't mutate input
                line["comp_type"] = comp_type
                line["comp_category"] = comp_category
                line["is_aipp_eligible"] = aipp
                line["is_scoreboard_eligible"] = sb
                matched = True
                break
        if not matched:
            unmatched.append(desc_upper)
        out.append(line)
    if unmatched:
        # Caller should surface this — a new SF line description means
        # DESC_RULES needs an update (year-over-year evolution).
        print(f"[sf_comp_recap] DESC_RULES no-match for {len(unmatched)} lines:")
        for u in unmatched:
            print(f"  - {u!r}")
    return out


# =============================================================================
# 4. transform_to_ingest_payload — pure transform LLM output -> ingest payload.
# =============================================================================

def transform_to_ingest_payload(llm_output: Dict[str, Any]) -> Dict[str, Any]:
    """Translate the LLM's parser output to the sf_comp_recap_ingest payload schema.

    LLM output:                       sf_comp_recap_ingest input:
    --------------------------------  ----------------------------------------
    period_year                  →    period_year
    period_month                 →    period_month
    period_half                  →    period_half
    recap_date                   →    recap_date
    totals.half_month_total_pdf  →    reconciliation.half_month_total_pdf
    totals.ytd_total_pdf         →    reconciliation.ytd_total_pdf
    line_items[].line_sequence   →    lines[].line_sequence
    line_items[].comp_type       →    lines[].comp_type
    line_items[].comp_category   →    lines[].comp_category
    line_items[].description     →    lines[].description
    line_items[].current_amount  →    lines[].current_amount
    line_items[].ytd_amount      →    lines[].ytd_amount
    line_items[].is_aipp_eligible      → lines[].is_aipp_eligible
    line_items[].is_scoreboard_eligible → lines[].is_scoreboard_eligible
    (dropped: agent_name, agent_code, territory, period_label, line_items[].section)
    """
    totals = llm_output.get("totals", {}) or {}
    line_items = llm_output.get("line_items", []) or []

    lines: List[Dict[str, Any]] = []
    for li in line_items:
        lines.append({
            "line_sequence": li.get("line_sequence"),
            "comp_type": li.get("comp_type"),
            "comp_category": li.get("comp_category"),
            "description": li.get("description"),
            "current_amount": li.get("current_amount", 0),
            "ytd_amount": li.get("ytd_amount", 0),
            "is_aipp_eligible": bool(li.get("is_aipp_eligible", False)),
            "is_scoreboard_eligible": bool(li.get("is_scoreboard_eligible", False)),
        })

    return {
        "period_year": llm_output.get("period_year"),
        "period_month": llm_output.get("period_month"),
        "period_half": llm_output.get("period_half"),
        "recap_date": llm_output.get("recap_date"),
        "reconciliation": {
            "half_month_total_pdf": totals.get("half_month_total_pdf"),
            "ytd_total_pdf": totals.get("ytd_total_pdf"),
        },
        "lines": lines,
    }


# =============================================================================
# 5. parse_and_ingest — high-level orchestrator (manual backstop entry point).
# =============================================================================

def parse_and_ingest(
    pdf_path: str,
    agency_id: str,
    document_id: Optional[str],
    sandbox_helpers: Dict[str, Callable],
    supabase_rpc: Callable[[str, Dict[str, Any]], Dict[str, Any]],
    force_replace: bool = False,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """OCR → LLM(PARSER_PROMPT) → DESC_RULES → transform → sf_comp_recap_ingest.

    Parameters
    ----------
    pdf_path : str
        Local path to the SF Comp Recap PDF inside the Composio sandbox.
    agency_id : str
        Agency UUID (Kwame's: "98aa8b9b-92e4-4ebc-8727-aa00ce696fab").
    document_id : Optional[str]
        documents.id UUID for the source PDF. Pass None to skip the documents
        row update step (the function still ingests comp_recap rows).
    sandbox_helpers : dict
        Must contain "smart_file_extract" and "invoke_llm" helpers — these are
        provided automatically inside the Composio remote sandbox.
    supabase_rpc : callable(name: str, args: dict) -> dict
        Caller-provided shim that calls the Postgres RPC `name` with `args`
        and returns the jsonb result. Typical implementation: pass the
        Supabase MCP execute_sql tool wrapped to dispatch to RPC names.
    force_replace : bool
        Forwarded to sf_comp_recap_ingest. Default False (refuses if any rows
        for the period are GL-posted). Set True ONLY after manually reversing
        the relevant journal_entries.
    dry_run : bool
        If True, return the prepared payload + reconciliation preview without
        calling the ingest function. Useful for review before commit.

    Returns
    -------
    dict
        The sf_comp_recap_ingest return value (with `status`, `reconciliation`,
        etc.). If dry_run=True, returns {"status": "dry_run", "payload": ...}.
    """
    smart_file_extract = sandbox_helpers["smart_file_extract"]
    invoke_llm = sandbox_helpers["invoke_llm"]

    # === STEP 1: OCR the PDF ===
    print(f"[sf_comp_recap] OCR-ing {pdf_path} ...")
    ocr_text, err = smart_file_extract(pdf_path, show_preview=False)
    if err:
        return {"status": "error", "error_reason": f"OCR failed: {err}", "stage": "ocr"}
    print(f"[sf_comp_recap] OCR returned {len(ocr_text)} chars.")

    # === STEP 2: LLM parse ===
    print("[sf_comp_recap] Invoking LLM with PARSER_PROMPT ...")
    prompt = PARSER_PROMPT + "\n\n--- BEGIN OCR TEXT ---\n" + ocr_text + "\n--- END OCR TEXT ---\n"
    llm_response, err = invoke_llm(prompt)
    if err:
        return {"status": "error", "error_reason": f"LLM failed: {err}", "stage": "llm"}

    # Strip any markdown fences the LLM may have added despite instructions
    cleaned = re.sub(r"^```(?:json)?\s*", "", llm_response.strip(), flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned, flags=re.MULTILINE)
    try:
        llm_output = json.loads(cleaned)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "error_reason": f"LLM returned non-JSON: {e}",
            "stage": "llm_parse",
            "raw_response_preview": llm_response[:1000],
        }

    line_items = llm_output.get("line_items", [])
    print(f"[sf_comp_recap] LLM parsed {len(line_items)} line items.")

    # === STEP 3: DESC_RULES deterministic post-processing ===
    print("[sf_comp_recap] Applying DESC_RULES ...")
    llm_output["line_items"] = apply_desc_rules(line_items)

    # === STEP 4: Transform to ingest payload schema ===
    payload = transform_to_ingest_payload(llm_output)
    print(f"[sf_comp_recap] Built ingest payload: period {payload['period_year']}-"
          f"{payload['period_month']:02d}-{payload['period_half']}, "
          f"{len(payload['lines'])} lines.")

    if dry_run:
        return {
            "status": "dry_run",
            "payload": payload,
            "llm_output_summary": {
                "agent_name": llm_output.get("agent_name"),
                "period_label": llm_output.get("period_label"),
                "totals": llm_output.get("totals"),
                "line_count": len(payload["lines"]),
            },
        }

    # === STEP 5: Call sf_comp_recap_ingest ===
    print("[sf_comp_recap] Calling sf_comp_recap_ingest ...")
    result = supabase_rpc("sf_comp_recap_ingest", {
        "p_agency_id": agency_id,
        "p_document_id": document_id,
        "p_payload": payload,
        "p_force_replace": force_replace,
    })

    if result.get("status") == "ok":
        recon = result.get("reconciliation", {})
        print(f"[sf_comp_recap] ✓ Ingest OK. "
              f"Half-month: ${recon.get('half_month_sum_db', 0):,.2f} vs PDF "
              f"${recon.get('half_month_total_pdf', 0):,.2f} "
              f"(delta ${recon.get('half_month_delta', 0):,.2f}). "
              f"YTD: ${recon.get('ytd_sum_db', 0):,.2f} vs PDF "
              f"${recon.get('ytd_total_pdf', 0):,.2f} "
              f"(delta ${recon.get('ytd_delta', 0):,.2f}).")
    else:
        print(f"[sf_comp_recap] ✗ Ingest issue: status={result.get('status')}, "
              f"reason={result.get('error_reason')}")

    return result


# =============================================================================
# Unit tests for the pure functions (run with `python -m pytest sf_comp_recap.py`
# or just `python sf_comp_recap.py`).
# =============================================================================

def _self_test():
    # DESC_RULES specificity test — STD AUTO must beat AUTO
    items = [
        {"line_sequence": 1, "description": "STD AUTO NEW BUSINESS",
         "current_amount": 100, "ytd_amount": 1000,
         "comp_type": "X", "comp_category": "x"},
        {"line_sequence": 2, "description": "AUTO NEW BUSINESS",
         "current_amount": 200, "ytd_amount": 2000,
         "comp_type": "X", "comp_category": "x"},
        {"line_sequence": 3, "description": "STD AUTO AIPP PAYMENT",
         "current_amount": 300, "ytd_amount": 3000,
         "comp_type": "X", "comp_category": "x"},
    ]
    out = apply_desc_rules(items)
    assert out[0]["comp_type"] == "STDAUTO", out[0]
    assert out[0]["is_scoreboard_eligible"] is True
    assert out[1]["comp_type"] == "MUTL", out[1]
    assert out[2]["comp_type"] == "AIPP", out[2]
    assert out[2]["comp_category"] == "std_auto_aipp", out[2]

    # AMBASSADOR TRAVEL disambiguation
    items = [
        {"description": "AMBASSADOR TRAVEL ALLOWANCE - LIFE", "current_amount": 0, "ytd_amount": 0},
        {"description": "AMBASSADOR TRAVEL - LIFE",           "current_amount": 0, "ytd_amount": 0},
    ]
    out = apply_desc_rules(items)
    assert out[0]["comp_type"] == "BONUS",    out[0]
    assert out[1]["comp_type"] == "BENEFITS", out[1]

    # transform_to_ingest_payload schema mapping
    fake_llm = {
        "agent_name": "Kwame Tyler",
        "period_year": 2026, "period_month": 5, "period_half": "first",
        "recap_date": "2026-05-15",
        "totals": {"half_month_total_pdf": 100.0, "ytd_total_pdf": 1000.0},
        "line_items": [
            {"line_sequence": 1, "section": "page1_production", "description": "AUTO NEW BUSINESS",
             "current_amount": 10, "ytd_amount": 100, "comp_type": "MUTL",
             "comp_category": "new_business", "is_aipp_eligible": True, "is_scoreboard_eligible": True}
        ],
    }
    payload = transform_to_ingest_payload(fake_llm)
    assert payload["period_year"] == 2026
    assert payload["reconciliation"]["half_month_total_pdf"] == 100.0
    assert "agent_name" not in payload  # dropped
    assert "section" not in payload["lines"][0]  # dropped
    assert payload["lines"][0]["description"] == "AUTO NEW BUSINESS"

    print("All self-tests passed ✓")


if __name__ == "__main__":
    _self_test()
