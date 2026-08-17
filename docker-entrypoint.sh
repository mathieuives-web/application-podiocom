#!/bin/sh
set -e

# Un seul volume persistant (/app/data) suffit pour tout : la base de données
# ET les fichiers uploadés (photos, devis, tickets...). Pratique sur les
# hébergeurs qui ne fournissent qu'un seul volume par service (ex: Railway).

mkdir -p /app/data/uploads

# Au premier démarrage, on copie la base pré-initialisée (schéma + comptes de
# démo) dans le volume persistant, si elle n'existe pas déjà.
if [ ! -f /app/data/dev.db ]; then
  echo "Initialisation de la base de données dans /app/data/dev.db ..."
  cp /app/prisma/seed.db /app/data/dev.db
fi

# Les fichiers uploadés sont réellement stockés dans /app/data/uploads ;
# on fait pointer public/uploads dessus pour que Next.js les serve normalement.
rm -rf /app/public/uploads
ln -s /app/data/uploads /app/public/uploads

export DATABASE_URL="file:/app/data/dev.db"

exec "$@"
