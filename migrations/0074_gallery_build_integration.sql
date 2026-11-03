-- Design Gallery -> AI builder integration (Founder directive 2026-11-03).
--
-- Until now design_reference_uses recorded only THAT a reference was selected. The Founder's requirement is
-- stronger: a build must record whether the reference's image was actually retrieved and actually put in front of
-- a model, because "the builder used the gallery" is otherwise an unfalsifiable claim. A reference that was chosen
-- but whose image never reached a model is a failure to report, not a detail to omit -- so the two facts are
-- separate columns with a default of 0, and nothing but the runner reporting success ever sets them to 1.

-- How relevant the reference was judged to be (services/industry-match.ts: 1 = the customer's own trade,
-- 0 = unrelated), and which gallery category produced that score.
ALTER TABLE design_reference_uses ADD COLUMN relevance REAL;
ALTER TABLE design_reference_uses ADD COLUMN matched_category TEXT;

-- 1 only once the runner has fetched the image bytes for this reference into the build workspace.
ALTER TABLE design_reference_uses ADD COLUMN image_delivered INTEGER NOT NULL DEFAULT 0;
-- 1 only once a vision-capable model has actually been sent this image in a prompt. Separate from delivery: a
-- text-only model can be given a path it cannot read, and that must never count as visual interpretation.
ALTER TABLE design_reference_uses ADD COLUMN model_saw INTEGER NOT NULL DEFAULT 0;
-- Which model saw it, so the evidence names the model rather than asserting "the AI".
ALTER TABLE design_reference_uses ADD COLUMN seen_by_model TEXT;
