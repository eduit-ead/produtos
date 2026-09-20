# Decisões do Agente

## 2026-09-20 — Batch production, storage and XLSX sync architecture

### Contexto
Implementar a primeira versão completa do fluxo de produção em lote, organização de arquivos, exportação WhatsApp, sincronização controlada com XLSX e preparação para armazenamento local ou bucket.

### Decisão
- Adotar estrutura determinística de arquivos por curso em `output/ai-catalog/<slug>/`:
  - `<slug>-fundo.png`
  - `<slug>-card.png`
  - `<slug>-whatsapp.jpg`
  - `metadata.json`
- Centralizar nomes em `src/batch/naming.js` (`courseFiles(slug)`).
- Criar `StorageProvider` desacoplada, com `LocalStorageProvider` ativo via `STORAGE_PROVIDER=local`.
- Cada curso possui `metadata.json` com status, hashes, timestamps, custo e storage keys.
- Lotes são jobs JSON em `output/ai-catalog/jobs/<jobId>.json` com estados de job e itens.
- Atualização da planilha é ação explícita via `/api/xlsx/sync` ou exportação `/api/xlsx/export`; dry-run via `/api/xlsx/sync-preview`.
- Nunca escrever na planilha automaticamente; sempre fazer backup antes.
- Docker e `.env.example` para futura publicação; sem deploy agora.

### Contratos principais

#### `StorageProvider`
```js
{
  async save(key, buffer, { contentType }),
  async exists(key),
  async getPublicUrl(key),
  async delete(key),
  async healthCheck()
}
```
Para local, `key = "<slug>/<tipo>"` e URL pública `"/api/files/<encodedKey>"`.

#### `courseFiles(slug)`
Retorna `{ slug, fundo: "<slug>-fundo.png", card: "<slug>-card.png", whatsapp: "<slug>-whatsapp.jpg" }`.

#### `metadata.json` por curso
```json
{
  "course_id": "...",
  "slug": "...",
  "curso": "...",
  "template_id": "cruzeiro-graduacao-v1",
  "prompt": "...",
  "model": "gpt-image-2.5-flare",
  "quality": "medium",
  "size": "1024x1024",
  "cost_usd": 0,
  "background_origin": "original | ia | upload",
  "files": { "fundo": "...", "card": "...", "whatsapp": "..." },
  "storage": { "provider": "local", "keys": { "fundo": "...", "card": "...", "whatsapp": "..." } },
  "urls": { "fundo": "...", "card": "...", "whatsapp": "..." },
  "hashes": { "fundo": "sha256", "card": "...", "whatsapp": "..." },
  "status": "pendente | gerando_fundo | fundo_gerado | renderizando_card | gerando_whatsapp | pronto_revisao | aprovado | rejeitado | erro | cancelado",
  "timestamps": { "generated_at": ..., "rendered_at": ..., "whatsapp_at": ..., "approved_at": ..., "rejected_at": ... },
  "error": null,
  "attempts": 0
}
```

#### Job de lote
```json
{
  "id": "job-<timestamp>-<random>",
  "status": "criado | executando | pausado | concluido | concluido_com_erros | cancelado | bloqueado",
  "template_id": "cruzeiro-graduacao-v1",
  "background_source": "original | upload | ia",
  "batch_size": 1,
  "concurrency": 1,
  "max_calls": null,
  "max_cost_usd": null,
  "model": "...",
  "quality": "...",
  "size": "...",
  "courses": [ { "course_id", "slug", "status", "error", "attempts", "cost_usd" } ],
  "stats": { "total", "completed", "errors", "approved", "rejected", "calls", "cost_usd" },
  "created_at": "...",
  "started_at": null,
  "completed_at": null,
  "error": null
}
```

#### Endpoints de API
- `GET /api/health`
- Lotes:
  - `GET /api/batches`
  - `POST /api/batches` (criar)
  - `GET /api/batches/:id`
  - `POST /api/batches/:id/start`
  - `POST /api/batches/:id/pause`
  - `POST /api/batches/:id/resume`
  - `POST /api/batches/:id/cancel`
  - `POST /api/batches/:id/retry-errors`
  - `POST /api/batches/:id/retry-rejected`
  - `GET /api/batches/:id/items`
- Cursos (já existentes) + `POST /api/courses/:slug/whatsapp`
- Arquivos:
  - `GET /api/catalog/:slug/:file`
  - `GET /api/files/:encodedKey`
- XLSX:
  - `POST /api/xlsx/sync-preview` (dry-run)
  - `POST /api/xlsx/sync`
  - `POST /api/xlsx/export`

### Alternativas descartadas
- Nomear arquivos com sufixos `-fundo-ia` e `-card-ia`: descartado para manter padrão único e limpo.
- Escrever na planilha automaticamente ao concluir cada imagem: descartado por segurança; optou-se por ação explícita.
- Implementar S3/Supabase agora: descartado; contratos preparados para futura integração.

### Impacto
- Novos módulos em `src/batch/` e `src/storage/`.
- Novas rotas em `src/template-editor/api.js`.
- Novas telas/seções no painel de cursos.
- Novos scripts de teste.
- `server.js` usa `HOST` e `PORT` configuráveis.
- Dockerfile e `.env.example` adicionados.
