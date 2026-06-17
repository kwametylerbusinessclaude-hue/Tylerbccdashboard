# Doc Processor v2.1 — Rebuild Instructions

## Status (2026-06-17 23:30 UTC)

The v2 multimodal LLM architecture (default model `llama-4-scout-17b-16e-instruct`) does NOT work via Composio's free Groq tool:

- `COMPOSIO_SEARCH_GROQ_CHAT` requires `messages.0.content` to be a STRING; multimodal content blocks rejected (HTTP 400).
- The default `llama-4-scout-17b-16e-instruct` and the documented fallback `llama-3.2-90b-vision-preview` are both absent from Composio's allowed Groq model list.

The OCR-then-text path via `COMPOSIO_SEARCH_GROQ_CHAT` with `llama-3.3-70b-versatile` is validated as the working alternative (same model the 2026-06-16 P2β workbench parser used).

## Architecture Decision: Path A (Edge Function calls Composio Workbench)

Selected over Path B (Vercel Python serverless) because:
- No new infra deploy needed
- No new paid service (free Composio LLM stays free)
- Composio's own recommended workflow for PDF→text says "use COMPOSIO_REMOTE_WORKBENCH"
- Sandbox cold-start latency (10-20s) acceptable for 30-min cron

## Pipeline (replaces v8's stageCParse)

1. Download PDF from Drive — already implemented via `GOOGLEDRIVE_DOWNLOAD_FILE` → `downloaded_file_content.s3url`
2. **OCR via Composio Workbench** — POST to `${COMPOSIO_BASE}/COMPOSIO_REMOTE_WORKBENCH` with embedded Python:
   ```python
   import urllib.request, os
   with urllib.request.urlopen("<s3url>") as r, open("/tmp/p.pdf","wb") as f:
       f.write(r.read())
   text, err = smart_file_extract("/tmp/p.pdf", show_preview=False)
   print(json.dumps({"text": text, "len": len(text)}))
   ```
   `smart_file_extract` is the Composio sandbox helper that auto-falls-back PyMuPDF text-layer → tesseract OCR.

3. **fix_one_number_lines() safety net (REBUILD — lost in sandbox reset)** — this is the critical 2026-06-16 P2β fix that's no longer in any file. Spec (from session note):
   > "OCR-grounded safety net. Re-parses each description's OCR line; counts decimal numbers via NUM_PAT regex. 1 num → cur=0/ytd=N; 2 nums → cur=first/ytd=second. Handles OCR-collapsed-column case (AMD66 renewals, AIPP, bonuses)."

   Pseudocode:
   ```ts
   const NUM_PAT = /-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?-?/g;
   function fixOneNumberLines(items: LineItem[], ocrText: string): LineItem[] {
     const ocrLines = ocrText.split("\n");
     return items.map(item => {
       const matchLine = ocrLines.find(l => l.toUpperCase().includes(item.description.toUpperCase()));
       if (!matchLine) return item;
       const nums = (matchLine.match(NUM_PAT) || []).map(s => parseAmount(s)); // strip commas, handle trailing minus
       if (nums.length === 1) return { ...item, current_amount: 0, ytd_amount: nums[0] };
       if (nums.length >= 2) return { ...item, current_amount: nums[0], ytd_amount: nums[1] };
       return item;
     });
   }
   ```

4. **Drop aggregate lines** — model occasionally retains "PAYABLE PER AGREEMENT" etc.  Defensive post-filter:
   ```ts
   const AGGREGATE_PREFIXES = ["TOTAL ", "GROSS COMPENSATION", "ADJUSTED GROSS",
     "LESS DEDUCTIONS", "NET PAYABLE", "PER SCHEDULES OF PAYMENT", "PAYABLE PER AGREEMENT",
     "YOUR CHECK FOR", "REQUESTED 100%"];
   items = items.filter(i => !AGGREGATE_PREFIXES.some(p => i.description.toUpperCase().startsWith(p)));
   ```

5. **applyDescRules** — already ported (v8 has it).
6. **transformToIngestPayload** — already in v8.
7. **sf_comp_recap_ingest RPC** — exists; safe-by-default (refuses to replace if any row is GL-posted).

## Reconciliation gotcha discovered 2026-06-17

The PDF's "GROSS COMPENSATION YTD" line ($261,435.21 on May 15 2026) excludes page-3 BENEFITS that ARE in comp_recap.lines. Current comp_recap.first.ytd sum is $266,675.21 — a $5,240 difference. Two options:

- (a) Drop BENEFITS lines from comp_recap to match PDF's gross compensation total
- (b) Use the PDF's "TOTAL PAYABLE PER AGREEMENT" line instead of "GROSS COMPENSATION" for the half-month total only, and accept that YTD is computed differently (page 1+2 = "gross compensation" while DB-side YTD includes BENEFITS)
- (c) Capture BOTH totals from the PDF: `gross_compensation_ytd_pdf` (page 2) AND `total_with_benefits_ytd_pdf` (computed by adding page 3 benefits lines) — match comp_recap sum against the latter

Recommend (c). This is a schema change to `sf_comp_recap_ingest` (or to its expected payload) but it's the most truthful and avoids data loss.

## Test Fixtures Available

In `/mnt/files/bcc/` during the 2026-06-17 sandbox session (DO NOT rely; sandbox does not actually persist):
- `may15_2026_pdf.b64` — base64 PDF
- `may15_ocr.txt` — 3,134-char OCR output via smart_file_extract
- `may15_llm_raw.txt` — raw Groq response (markdown-fenced)
- `may15_parsed.json` — cleaned and parsed line_items JSON (31 items; includes the bad "PAYABLE PER AGREEMENT" and truncated-decimal artifacts)

If rebuilding from scratch: re-download from Drive file_id `1qGmqDVot_ClbhoTDmoHqr7BS2w_Z2YQy`.

## Known State

- automation-runner v7 LIVE in production (deployed 2026-06-17 23:00 UTC, ezbr_sha256 `318120ebab470720fc910820bdb69b930d2ac8e4b13197ef1442ed14b61b9011`).
- Doc Processor recipe (`98d091d4`) is_active=true, groq_parse_enabled=false, gating off the broken v2 multimodal path.
- All 3 Social recipes is_active=false, awaiting Kwame's activation gate work.
- comp_recap is correct: Apr 30 2026 second-half orphan linkage fixed 2026-06-17 23:18; no remaining orphans; row-count variation per period reflects legitimate variation in line-items, not parser failures.
