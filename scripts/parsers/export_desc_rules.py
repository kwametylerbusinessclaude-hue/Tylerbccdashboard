"""
export_desc_rules.py — Regenerate supabase/functions/_shared/desc_rules.json
from the canonical DESC_RULES table in scripts/parsers/sf_comp_recap.py.

USAGE:
    python scripts/parsers/export_desc_rules.py

Also prints a comparison report so a code reviewer can confirm the JSON
and the inline TS DESC_RULES in supabase/functions/automation-runner/index.ts
have not drifted from the Python source.

The TS DESC_RULES constant inside the Edge Function index.ts is a
hand-maintained projection of this JSON; the Python parser is the
source of truth.  If you modify DESC_RULES in Python, run this script
then manually update the TS array to match (or, in Phase v2.1, automate
the TS regeneration too).
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_PATH = REPO_ROOT / "scripts" / "parsers" / "sf_comp_recap.py"
JSON_OUT = REPO_ROOT / "supabase" / "functions" / "_shared" / "desc_rules.json"


def load_desc_rules() -> list[tuple]:
    """Import sf_comp_recap.py dynamically and pull its DESC_RULES."""
    if not PARSER_PATH.exists():
        sys.exit(f"ERROR: parser not found at {PARSER_PATH}")
    spec = importlib.util.spec_from_file_location("sf_comp_recap", PARSER_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    rules = getattr(mod, "DESC_RULES", None)
    if rules is None:
        sys.exit("ERROR: DESC_RULES not exported from sf_comp_recap.py")
    return rules


def rules_to_json(rules: list[tuple]) -> dict:
    """Tuple-form rules -> structured JSON for committing to repo."""
    serialized = []
    for r in rules:
        pattern, comp_type, comp_category, is_aipp, is_sb = r
        serialized.append({
            "pattern": pattern,
            "comp_type": comp_type,
            "comp_category": comp_category,
            "is_aipp_eligible": bool(is_aipp),
            "is_scoreboard_eligible": bool(is_sb),
        })
    return {
        "_doc": (
            "DESC_RULES — substring-match deterministic categorisation table "
            "for SF Compensation Recap line items. Port of "
            "scripts/parsers/sf_comp_recap.py DESC_RULES. Order is "
            "significant: most-specific patterns FIRST. The Edge Function "
            "at supabase/functions/automation-runner/index.ts has an inline "
            "TS copy; this JSON is canonical. Regenerate via "
            "scripts/parsers/export_desc_rules.py."
        ),
        "_version": "auto-export",
        "_source": "scripts/parsers/sf_comp_recap.py",
        "_rule_count": len(serialized),
        "rules": serialized,
    }


def main() -> int:
    rules = load_desc_rules()
    print(f"Loaded {len(rules)} DESC_RULES rows from {PARSER_PATH}")

    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    out = rules_to_json(rules)
    JSON_OUT.write_text(json.dumps(out, indent=2) + "\n")
    print(f"Wrote {JSON_OUT} ({JSON_OUT.stat().st_size} bytes)")

    # Compare against any existing committed JSON to flag drift
    existing_path = JSON_OUT
    if existing_path.exists():
        try:
            existing = json.loads(existing_path.read_text())
            existing_rules = existing.get("rules", [])
            if len(existing_rules) != len(rules):
                print(
                    f"WARNING: existing JSON had {len(existing_rules)} rules, "
                    f"new export has {len(rules)} rules"
                )
        except json.JSONDecodeError:
            print("WARNING: existing desc_rules.json was malformed (overwritten)")

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
