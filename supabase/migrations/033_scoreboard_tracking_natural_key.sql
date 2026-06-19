-- Migration 033: scoreboard_tracking natural-key uniqueness
-- Adds (agency_id, program_year, metric_name) uniqueness so backfill / upserts are idempotent.
-- Future: when SF publishes targets, an upsert on this triple updates the row instead of duplicating.

ALTER TABLE public.scoreboard_tracking
  ADD CONSTRAINT scoreboard_tracking_agency_year_metric_uk
  UNIQUE (agency_id, program_year, metric_name);
