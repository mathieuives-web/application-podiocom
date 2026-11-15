#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Démarrage de Start Invest. Tout est automatique, y compris sur Railway :
#  - dossier de données : volume Railway s'il existe, sinon /app/data ;
#  - clé secrète (AUTH_SECRET) générée au premier démarrage si elle n'est pas fournie ;
#  - adresse publique (NEXTAUTH_URL) déduite du domaine Railway ;
#  - base de données créée au premier démarrage, puis mise à jour à chaque nouvelle version ;
#  - l'application tourne ensuite avec un utilisateur sans privilèges.
# ---------------------------------------------------------------------------

DATA="${RAILWAY_VOLUME_MOUNT_PATH:-${DATA_DIR:-/app/data}}"
export DATA_DIR="$DATA"
mkdir -p "$DATA/documents"

if [ -n "$RAILWAY_ENVIRONMENT" ] && [ -z "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
  echo "⚠️  ATTENTION : aucun volume Railway n'est attaché. Base et documents seront EFFACÉS au prochain déploiement."
  echo "⚠️  Ajoutez un volume monté sur /app/data (clic droit sur le service > Attach volume)."
  export PERSISTENT_STORAGE=no
else
  export PERSISTENT_STORAGE=yes
fi

# Clé secrète : fournie par l'hébergeur, ou générée une fois et conservée dans le volume.
if [ -z "$AUTH_SECRET" ]; then
  if [ ! -s "$DATA/.auth-secret" ]; then
    echo "Génération de la clé secrète (première installation)..."
    head -c 48 /dev/urandom | base64 | tr -d '\n' > "$DATA/.auth-secret"
  fi
  AUTH_SECRET="$(cat "$DATA/.auth-secret")"
  export AUTH_SECRET
fi

# Adresse publique du site.
if [ -z "$NEXTAUTH_URL" ] && [ -n "$RAILWAY_PUBLIC_DOMAIN" ]; then
  export NEXTAUTH_URL="https://$RAILWAY_PUBLIC_DOMAIN"
fi
export AUTH_TRUST_HOST="${AUTH_TRUST_HOST:-true}"
export DATABASE_URL="file:$DATA/dev.db"

# Base de données : création au premier démarrage, puis mise à jour du schéma (sans perte de données).
if [ ! -f "$DATA/dev.db" ]; then
  echo "Initialisation de la base de données..."
  cp /app/prisma/seed.db "$DATA/dev.db"
fi
node /opt/prisma-cli/node_modules/prisma/build/index.js db push --skip-generate --schema /app/prisma/schema.prisma

# Droits : seul l'utilisateur de l'application lit les données.
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA"
  chmod 700 "$DATA" "$DATA/documents"
  chmod 600 "$DATA/dev.db" "$DATA/.auth-secret" 2>/dev/null || true
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi
  echo "⚠️  setpriv indisponible : l'application tourne en root."
fi
exec "$@"
