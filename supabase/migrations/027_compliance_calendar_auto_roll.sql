
-- ============================================================
-- Migration 027 — Compliance calendar auto-roll on completion
--
-- Problem: compliance_calendar has no mechanism to roll recurring
-- items (monthly/annual) forward. Three items are stuck on past
-- due dates because nothing creates the next-period instance when
-- they're marked completed. The UI shows stale "upcoming" status
-- for items that are weeks overdue.
--
-- Fix: trigger on AFTER UPDATE OF status. When status transitions
-- from non-final to final ('completed' or 'rolled_forward'), and
-- recurrence is 'monthly' or 'annual', insert the next instance
-- with due_date shifted by the appropriate interval. Trigger is
-- idempotent — won't double-create if the same future row exists.
--
-- 'rolled_forward' is a new status value used for items that were
-- past-due and rolled without actually being reviewed (honest audit
-- trail vs falsely claiming a review happened).
--
-- Catch-up: the 3 stale items are flipped to 'rolled_forward',
-- which fires the trigger and spawns their next-period instances.
-- For items still past-due after one roll, the user/Claude can
-- repeat the close cycle.
-- ============================================================

CREATE OR REPLACE FUNCTION public.roll_completed_compliance_item()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_next_due DATE;
BEGIN
  -- Only act on transitions INTO a final status
  IF NEW.status NOT IN ('completed', 'rolled_forward') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = NEW.status THEN
    RETURN NEW;   -- no-op update; don't re-fire
  END IF;

  -- Only roll recurring items
  IF NEW.recurrence NOT IN ('monthly', 'annual') OR NEW.due_date IS NULL THEN
    RETURN NEW;
  END IF;

  -- Compute next due date
  v_next_due := CASE NEW.recurrence
                  WHEN 'monthly' THEN (NEW.due_date + INTERVAL '1 month')::date
                  WHEN 'annual'  THEN (NEW.due_date + INTERVAL '1 year')::date
                END;

  -- Idempotent: only insert if no row already exists with the same
  -- rule_id + due_date (catches double-completion races and reruns)
  INSERT INTO public.compliance_calendar (
    agency_id, compliance_rule_id, title, description, due_date,
    recurrence, status, alert_days_before, created_at
  )
  SELECT NEW.agency_id, NEW.compliance_rule_id, NEW.title, NEW.description,
         v_next_due, NEW.recurrence, 'upcoming', NEW.alert_days_before, NOW()
  WHERE NOT EXISTS (
    SELECT 1 FROM public.compliance_calendar
    WHERE agency_id = NEW.agency_id
      AND COALESCE(compliance_rule_id::text, '') = COALESCE(NEW.compliance_rule_id::text, '')
      AND title = NEW.title
      AND due_date = v_next_due
  );

  RETURN NEW;
END;
$function$;

-- Wire trigger
DROP TRIGGER IF EXISTS trg_roll_completed_compliance_item ON public.compliance_calendar;

CREATE TRIGGER trg_roll_completed_compliance_item
  AFTER UPDATE OF status ON public.compliance_calendar
  FOR EACH ROW
  WHEN (NEW.status IN ('completed', 'rolled_forward'))
  EXECUTE FUNCTION public.roll_completed_compliance_item();

-- ============================================================
-- Catch-up: roll the 3 stale items forward.
-- The trigger will auto-create next-period instances.
-- ============================================================
UPDATE public.compliance_calendar
SET status = 'rolled_forward',
    completed_at = NOW(),
    completed_by = 'system_catchup_2026-06-17'
WHERE agency_id = '98aa8b9b-92e4-4ebc-8727-aa00ce696fab'
  AND id IN (
    'c9278db4-1b15-4e69-b8f9-9785eea98543', -- Monthly Auto Application Compliance Review (5/31)
    '866b1098-8f18-46df-9162-91bbd2996dde', -- Monthly Altered Monies History Review (5/31)
    '4285df0e-dccd-496b-a978-e9912ec43a71'  -- [OFFICE] Monthly PFA Bank Statement Reconciliation (6/15)
  );

-- The 5/31 ones rolled to 6/30 (still past today's 6/17 — these are monthly reviews so 6/30 is the natural next due date, the close cycle catches up week-by-week).
-- The 6/15 PFA item rolled to 7/15 (future, good).
