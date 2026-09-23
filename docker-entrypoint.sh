#!/bin/sh
# Sobe como root apenas na primeira preparação do volume e entrega o processo ao usuário app.
set -eu

persist="${APP_RUNTIME_DIR:-/app/persistent}"
marker="$persist/.bwipoart-initialized"

if ! command -v setpriv >/dev/null 2>&1; then
  echo "setpriv não está disponível na imagem." >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  if [ ! -f "$marker" ]; then
    mkdir -p \
      "$persist/data/templates" \
      "$persist/data/assets" \
      "$persist/data/collections" \
      "$persist/data/imports" \
      "$persist/input/backups" \
      "$persist/input/cache" \
      "$persist/output/ai-catalog" \
      "$persist/output/exports" \
      "$persist/output/final" \
      "$persist/output/whatsapp"
    # Uma vez só: ajusta o dono sem apagar arquivos já presentes no volume.
    chown -R app:app "$persist"
    touch "$marker"
    chown app:app "$marker"
  fi
  exec setpriv --reuid=app --regid=app --init-groups -- "$@"
fi

exec "$@"
