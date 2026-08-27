#!/usr/bin/env bash
#
# Prepare the Netlify preview database.
#
#   scripts/netlify-db.sh 'postgresql://...'
#
# Netlify only exposes the provisioned connection string through an interactive client, so the URL
# has to be handed in. Get it from the project's Database tab, or:
#
#   netlify database connect --filter @drishtinet/web
#
# Everything after that is automated: PostGIS, schema, roles, and a copy of the index so the
# operator surface has something real to show.
#
# ── What is copied, and what is deliberately not ────────────────────────────────────────────────
#
# Copied: the camera registry, the detection/track/signature index, watchlists and alerts. This is
# metadata derived from the organisers' footage — appearance embeddings and bounding boxes, no
# imagery.
#
# Never copied: video of any kind. The evidence ring buffer and the development fixtures stay on the
# machine that produced them, as CLAUDE.md requires.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_URL=${1:-}
if [[ -z $REMOTE_URL ]]; then
  echo "usage: scripts/netlify-db.sh 'postgresql://...'" >&2
  echo "get the URL from: netlify database connect --filter @drishtinet/web" >&2
  exit 2
fi

set -a; [ -f .env ] && . ./.env; set +a
LOCAL_DB=${POSTGRES_DB:-drishtinet}
LOCAL_USER=${POSTGRES_USER:-drishti}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "1/5  PostGIS"
# The registry stores camera positions as geography, and route reconstruction reads them back with
# st_y/st_x. Without the extension every map query fails at run time rather than at deploy time.
psql "$REMOTE_URL" -v ON_ERROR_STOP=1 -c "create extension if not exists postgis;" \
  && psql "$REMOTE_URL" -tAc "select postgis_version();" | sed 's/^/     postgis /' \
  || { echo "     PostGIS is not available on this database — the registry and route pages cannot work without it." >&2; exit 1; }

step "2/5  Schema"
DATABASE_URL="$REMOTE_URL" pnpm --filter @drishtinet/db exec prisma migrate deploy

step "3/5  Seed (departments, roles, users, camera registry)"
DATABASE_URL="$REMOTE_URL" pnpm --filter @drishtinet/db seed

step "4/5  Copy the index"
# Data only, and only the tables the read side needs. --data-only keeps the schema Prisma just
# created rather than replacing it with a dump that could drift from the migrations.
TABLES=(detections tracks vehicle_signatures plates watchlists watchlist_entries alerts events)
ARGS=(); for t in "${TABLES[@]}"; do ARGS+=(-t "public.$t"); done

docker exec drishti-postgres pg_dump -U "$LOCAL_USER" -d "$LOCAL_DB" \
  --data-only --no-owner --no-privileges --disable-triggers "${ARGS[@]}" \
  > .cache/index-dump.sql

echo "     dumped $(wc -l < .cache/index-dump.sql | tr -d ' ') lines"

# Truncate first so re-running this is idempotent rather than duplicating every row.
psql "$REMOTE_URL" -v ON_ERROR_STOP=1 -q -c \
  "truncate ${TABLES[*]// /, } restart identity cascade;" 2>/dev/null || true
psql "$REMOTE_URL" -v ON_ERROR_STOP=1 -q -f .cache/index-dump.sql
rm -f .cache/index-dump.sql

step "5/5  Point the site at it"
netlify env:set DATABASE_URL "$REMOTE_URL" --filter @drishtinet/web --context production --secret >/dev/null
echo "     DATABASE_URL set for production"

printf '\n\033[1mVerifying\033[0m\n'
psql "$REMOTE_URL" -tAc "
  select '     cameras     ' || count(*) from cameras
  union all select '     detections  ' || count(*) from detections
  union all select '     signatures  ' || count(*) from vehicle_signatures
  union all select '     alerts      ' || count(*) from alerts;"

printf '\nNow redeploy so the site picks up DATABASE_URL:\n\n'
printf '  netlify deploy --build --prod --filter @drishtinet/web\n\n'
