-- The whole-clip scene description from the vision pass ( TASK-A), kept with the analysis. One row per clip.
ALTER TABLE reference_analysis_cache ADD COLUMN IF NOT EXISTS scene jsonb;
