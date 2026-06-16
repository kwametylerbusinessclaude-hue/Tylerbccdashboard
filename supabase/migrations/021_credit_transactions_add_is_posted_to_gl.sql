-- Match the bank_transactions pattern so skip-rule txns (which have no
-- journal_entry_id but ARE done) can be distinguished from unprocessed ones.
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS is_posted_to_gl boolean NOT NULL DEFAULT false;

-- Backfill: any CC txn that already has a JE is by definition posted.
UPDATE public.credit_transactions
SET is_posted_to_gl = true
WHERE journal_entry_id IS NOT NULL
  AND is_posted_to_gl = false;
