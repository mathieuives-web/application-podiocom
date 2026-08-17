# Podiocom Fleet

Application web interne pour Podiocom : gestion du parc de camions et remorques, contrôles
techniques / visites Mine avec rappels, entretiens et frais, planning des départs et
arrivées (chauffeurs et locataires), partenaires (prestataires / locataires), devis Excel,
photos et fiches techniques, tickets et factures capturés en mission, et gestion des accès
du personnel. Accès protégé par email + mot de passe, plusieurs profils (Administrateur,
Employé, Chauffeur, Locataire).

## Fonctionnalités

- **Parc** : fiche par camion/remorque (type, immatriculation, numéro de châssis, marque,
  modèle), historique des frais/entretiens avec prestataire, contrôle technique et visite
  Mine avec calcul automatique de la date d'expiration et alerte selon un délai configurable,
  tâches "à prévoir" avec sélection du prestataire, photos et fiche technique (upload
  fichier ou capture directe via webcam/caméra du téléphone).
- **Planning** : emploi du temps des départs/arrivées par véhicule, avec chauffeur ou
  locataire, filtrable par immatriculation et par date.
- **Partenaires** : registre unique des prestataires et des locataires, réutilisé partout
  (menus déroulants) au lieu de ressaisir l'information.
- **Devis** : chargement d'un dossier Excel par devis, remplaçable en un clic pour le
  modifier facilement, éventuellement lié à un véhicule.
- **Mes missions** (chauffeurs/locataires) : chaque chauffeur ou locataire voit ses
  missions et peut y ajouter en temps réel une photo de ticket essence, facture d'hôtel ou
  dégât constaté — directement rattachée à l'historique du véhicule.
- **Employés** : création de plusieurs accès (email + mot de passe) pour le personnel
  Podiocom, les chauffeurs et les locataires, avec rôles.
- **Paramètres** : durée de validité du CT et de la visite Mine par type de véhicule, et
  délai de rappel avant échéance.

## Comptes de démonstration (données de test incluses)

| Rôle | Email | Mot de passe |
|---|---|---|
| Administrateur | admin@podiocom.com | podiocom2026 |
| Chauffeur | chauffeur1@podiocom.com | chauffeur2026 |
| Locataire | locataire1@podiocom.com | locataire2026 |

**Changez ces mots de passe dès la mise en production**, dans le menu *Employés* (réservé
aux administrateurs), et supprimez les comptes de démonstration si besoin.

## Stack technique

Next.js 16 (App Router, Server Actions) · TypeScript · Tailwind CSS · Prisma ORM ·
SQLite (par défaut, changeable pour PostgreSQL) · NextAuth v5 (email + mot de passe).

## Lancer en local (développement)

Prérequis : Node.js 20+.

```bash
npm install
cp .env.example .env
# générez un secret avec : openssl rand -base64 32
# collez-le dans AUTH_SECRET du fichier .env

npm run db:push     # crée la base SQLite à partir du schéma
npm run db:seed     # ajoute les comptes et données de démonstration
npm run dev          # http://localhost:3000
```

## Mettre l'application en ligne avec un lien public

Deux façons d'obtenir une vraie URL publique. La première (Railway) ne demande ni serveur
ni nom de domaine à acheter — c'est la plus rapide pour démarrer. La seconde (VPS +
Docker) donne un contrôle total et une URL avec votre propre domaine.

### Option rapide : Railway (aucun serveur ni domaine à gérer)

Railway construit l'image Docker fournie et vous donne automatiquement une URL publique
en `https://....up.railway.app`, avec HTTPS déjà en place.

**Ce qu'il vous faut :** Node.js installé sur votre ordinateur (pour lancer une seule
commande de déploiement), et un compte Railway gratuit.

1. Créez un compte sur [railway.app](https://railway.app) (inscription possible avec un
   compte GitHub ou par email).
2. Sur votre ordinateur, décompressez `podiocom-fleet.zip`, ouvrez un terminal dedans et
   installez l'outil Railway :
   ```bash
   npm install -g @railway/cli
   railway login
   ```
   (Une page web s'ouvre pour confirmer la connexion.)
3. Créez le projet et lancez le déploiement :
   ```bash
   railway init
   railway up
   ```
   Railway construit l'image à partir du `Dockerfile` fourni (ça prend quelques minutes
   la première fois).
4. Ajoutez un stockage persistant (pour que la base de données et les fichiers uploadés
   ne soient pas effacés à chaque redéploiement) : dans le tableau de bord Railway →
   votre service → onglet **Volumes** → *New Volume* → point de montage `/app/data`.
5. Toujours dans le tableau de bord, onglet **Variables**, ajoutez :
   ```
   AUTH_SECRET=<valeur générée avec: openssl rand -base64 32>
   AUTH_TRUST_HOST=true
   ```
6. Onglet **Settings → Networking** → *Generate Domain* pour obtenir votre URL publique
   (ex. `podiocom-fleet-production.up.railway.app`). Copiez-la, puis ajoutez une dernière
   variable :
   ```
   NEXTAUTH_URL=https://podiocom-fleet-production.up.railway.app
   ```
7. Le service redémarre automatiquement après l'ajout des variables. Ouvrez l'URL :
   l'application est en ligne. Connectez-vous avec le compte administrateur de
   démonstration puis **changez immédiatement son mot de passe** et créez les comptes
   réels du personnel dans *Employés*.

Pour republier après une modification du code : relancez simplement `railway up` depuis
le dossier du projet.

### Option contrôle total : Docker sur un VPS avec votre propre domaine

C'est la solution à privilégier si vous avez déjà (ou voulez) un serveur et un nom de
domaine à vous, avec HTTPS automatique via Caddy.

**Ce qu'il vous faut :**

- Un petit serveur (VPS) chez un hébergeur au choix (OVH, Hetzner, DigitalOcean,
  Contabo...), avec Docker installé. 1 CPU / 1 Go de RAM suffit largement pour une
  structure comme Podiocom.
- Un nom de domaine (ou sous-domaine) pointant vers l'adresse IP du serveur.

**Étapes :**

1. Copiez tout le contenu de ce dossier sur le serveur (`git clone` si vous le mettez sur
   un dépôt Git privé, ou `scp`/`rsync`).
2. Modifiez `Caddyfile` : remplacez `votre-domaine.com` par votre vrai nom de domaine.
3. Créez un fichier `.env` à la racine avec :
   ```
   AUTH_SECRET=<valeur générée avec: openssl rand -base64 32>
   NEXTAUTH_URL=https://votre-domaine.com
   ```
4. Démarrez :
   ```bash
   docker compose up -d --build
   ```
5. L'application est accessible sur `https://votre-domaine.com` (le certificat HTTPS est
   généré automatiquement par Caddy). Connectez-vous avec le compte administrateur de
   démonstration puis changez immédiatement son mot de passe et créez les comptes réels du
   personnel dans *Employés*.

Toutes les données (base SQLite + fichiers uploadés : photos, devis, tickets...) sont
stockées dans le dossier `./data` sur le serveur — pensez à le sauvegarder régulièrement
(une simple copie de ce dossier suffit).

Pour mettre à jour l'application après une modification du code :
```bash
docker compose up -d --build
```

### Alternative : hébergement serverless (Vercel)

Possible, mais demande deux adaptations car Vercel ne fournit pas de disque persistant :

1. Remplacer SQLite par une base PostgreSQL managée (ex. Neon, Supabase — gratuites pour
   démarrer) : changez `provider = "sqlite"` en `provider = "postgresql"` dans
   `prisma/schema.prisma` et mettez à jour `DATABASE_URL`.
2. Remplacer le stockage de fichiers local (`src/lib/storage.ts`) par un stockage objet
   (ex. Vercel Blob, AWS S3, Cloudflare R2) : c'est le seul fichier à adapter, la fonction
   `saveUploadedFile` centralise tous les uploads (photos, devis, tickets...).

C'est plus de travail initial ; l'option Docker + VPS ci-dessus fonctionne "telle quelle"
avec le code fourni.

## Structure du projet

```
src/
  app/
    login/                 page de connexion
    (app)/                 pages protégées (nécessitent une session)
      page.tsx              tableau de bord
      parc/                 fiche véhicules (camions/remorques)
      planning/             départs/arrivées
      partenaires/          prestataires & locataires
      devis/                dossiers Excel de devis
      mes-missions/         espace chauffeur/locataire (tickets, factures, dégâts)
      employes/             gestion des accès (admin uniquement)
      parametres/           durée de validité CT/Mine + rappels
  components/
    DocumentUploadForm.tsx  upload fichier + capture caméra en direct
  lib/
    prisma.ts, storage.ts, inspections.ts, roles.ts, session.ts
  auth.ts, auth.config.ts   authentification (NextAuth v5)
prisma/
  schema.prisma             modèle de données complet
  seed.ts                   comptes et données de démonstration
```

## Sécurité

- Toutes les pages sont protégées par middleware : un utilisateur non connecté est
  redirigé vers `/login`.
- Les mots de passe sont hashés (bcrypt), jamais stockés en clair.
- Les chauffeurs/locataires ne peuvent ajouter des documents que sur leurs propres
  missions (vérifié côté serveur).
- Générez un `AUTH_SECRET` unique et gardez-le confidentiel — ne réutilisez pas la valeur
  d'exemple.

## Aller plus loin

Idées d'évolutions naturelles une fois l'application en production : notifications par
email/SMS pour les rappels de CT/Mine, vue calendrier pour le planning, export PDF des
fiches véhicule, tableau de bord des coûts par véhicule.
