#!/bin/sh
set -e

# Un seul volume persistant (/app/data) contient la base de données.
mkdir -p /app/data/documents
chmod 700 /app/data /app/data/documents 2>/dev/null || true

# Au premier démarrage, on copie la base pré-initialisée (schéma + sociétés + compte fondateur).
if [ ! -f /app/data/dev.db ]; then
  echo "Initialisation de la base de données dans /app/data/dev.db ..."
  cp /app/prisma/seed.db /app/data/dev.db
fi

export DATABASE_URL="file:/app/data/dev.db"

exec "$@"
