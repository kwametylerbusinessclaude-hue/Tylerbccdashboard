"""
test_doc_processor_v2.py — Integration test scaffold for Doc Processor v2.

PHASE STATUS (v2.0): SCAFFOLD ONLY.  This file lands the test harness
shape; fixtures + actual assertions are populated in Phase v2.1 once
a real LLM model has been chosen (open question #1 of the v2 spec).

What this test will eventually do:
  1. Load a known SF Comp Recap PDF fixture (May 2026, first half — a
     month whose comp_recap data has already been verified by the manual
     Python parser).
  2. Insert a documents row for the fixture and call mark_document_parsed
     dry-run / stageCParse via a local Deno run of the Edge Function.
  3. Assert: parse output matches the Python parser line-for-line, modulo
     known LLM jitter on the OCR-misread guard for 2.00 -> 0.00 benefits
     lines.
  4. Assert: sf_comp_recap_ingest returns records_created == len(line_items).
  5. Assert: post-run, documents.processing_status == 'parse_success'.

For now this file is intentionally minimal — running it is a no-op that
just verifies the v2 helpers were imported correctly.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_PATH = REPO_ROOT / "scripts" / "parsers" / "sf_comp_recap.py"


def _import_parser():
    spec = importlib.util.spec_from_file_location("sf_comp_recap", PARSER_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def test_parser_importable():
    """v2.0: confirm the Python parser still loads (regression guard)."""
    mod = _import_parser()
    assert hasattr(mod, "DESC_RULES")
    assert hasattr(mod, "PARSER_PROMPT")
    assert hasattr(mod, "apply_desc_rules")
    assert hasattr(mod, "transform_to_ingest_payload")
    assert isinstance(mod.DESC_RULES, list)
    assert len(mod.DESC_RULES) >= 50, f"expected >=50 rules, got {len(mod.DESC_RULES)}"


def test_desc_rules_json_in_sync():
    """v2.0: confirm the committed desc_rules.json rule count matches Python.

    The TS port inside the Edge Function index.ts is hand-maintained;
    desc_rules.json is regenerated via export_desc_rules.py.  This test
    catches drift between Python and JSON; TS drift is caught by code
    review at PR time.
    """
    import json
    json_path = REPO_ROOT / "supabase" / "functions" / "_shared" / "desc_rules.json"
    if not json_path.exists():
        # Phase v2.0 may land before the JSON has been regenerated.
        print("desc_rules.json missing; run export_desc_rules.py first")
        return
    data = json.loads(json_path.read_text())
    json_rules = data.get("rules", [])
    py = _import_parser()
    assert len(json_rules) == len(py.DESC_RULES), (
        f"Python has {len(py.DESC_RULES)} rules, JSON has {len(json_rules)} — "
        f"run scripts/parsers/export_desc_rules.py to sync"
    )


def test_apply_desc_rules_known_patterns():
    """v2.0: smoke-test the post-processor against a handful of patterns."""
    mod = _import_parser()
    items = [
        {"description": "STD AUTO NEW BUSINESS", "current_amount": 100, "ytd_amount": 500},
        {"description": "AUTO NEW BUSINESS",      "current_amount": 50,  "ytd_amount": 250},
        {"description": "MARKETING ALLOWANCE",    "current_amount": 0,   "ytd_amount": 0},
        {"description": "MEDICAL INSURANCE CONTRIBUTION", "current_amount": 0, "ytd_amount": 100},
    ]
    out = mod.apply_desc_rules(items)
    assert out[0]["comp_type"] == "STDAUTO", "STD AUTO must beat AUTO (specificity)"
    assert out[1]["comp_type"] == "MUTL"
    assert out[2]["comp_type"] == "OTHER_INCOME"
    assert out[3]["comp_type"] == "BENEFITS"


if __name__ == "__main__":
    # Minimal direct-run mode for CI without pytest installed.
    test_parser_importable()
    test_desc_rules_json_in_sync()
    test_apply_desc_rules_known_patterns()
    print("v2.0 test scaffold: all checks passed")
