-- Coleções e registros do BwipoArt.
-- Aplicar somente no banco bwipoart, via scripts/apply-db-migrations.js.
-- O servidor não executa este arquivo ao iniciar.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  default_template_id TEXT,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT collections_id_format CHECK (id ~ '^[a-zA-Z0-9_-]+$')
);

CREATE INDEX IF NOT EXISTS collections_archived_idx ON collections (archived);
CREATE INDEX IF NOT EXISTS collections_template_idx ON collections (default_template_id);

CREATE TABLE IF NOT EXISTS collection_records (
  collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_key TEXT,
  title TEXT NOT NULL DEFAULT '',
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  record JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, item_id)
);

CREATE INDEX IF NOT EXISTS collection_records_slug_idx ON collection_records (collection_id, slug);
CREATE INDEX IF NOT EXISTS collection_records_source_key_idx ON collection_records (collection_id, source_key);
CREATE INDEX IF NOT EXISTS collection_records_fields_gin ON collection_records USING GIN (fields);
