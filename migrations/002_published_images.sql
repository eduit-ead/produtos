-- Publicação manual da imagem principal de um registro.
-- Uma publicação por collection_id + item_id. A URL pública não muda entre versões.
-- Aplicar somente no banco bwipoart. O servidor não executa este arquivo ao iniciar.

CREATE TABLE IF NOT EXISTS published_images (
  collection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  public_id TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  finished_piece_id TEXT NOT NULL,
  file_key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, item_id),
  CONSTRAINT published_images_version_positive CHECK (version >= 1),
  CONSTRAINT published_images_record_fk
    FOREIGN KEY (collection_id, item_id)
    REFERENCES collection_records (collection_id, item_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS published_images_piece_idx ON published_images (finished_piece_id);

CREATE TABLE IF NOT EXISTS published_image_versions (
  collection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  finished_piece_id TEXT NOT NULL,
  file_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collection_id, item_id, version),
  CONSTRAINT published_image_versions_fk
    FOREIGN KEY (collection_id, item_id)
    REFERENCES published_images (collection_id, item_id)
    ON DELETE CASCADE
);
