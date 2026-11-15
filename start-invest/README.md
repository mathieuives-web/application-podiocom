# Start Invest — pilotage du groupe

Application privée du groupe **Start Invest** (holding) : un board d'agents IA qui pilote chaque
société, la trésorerie consolidée et les connexions aux banques et logiciels de facturation.

Sociétés du groupe : **Start Invest** (holding), **La Fabrique Automobile** (vente, dépôt-vente,
recherche personnalisée, carte grise, communication), **Auto Rac Ives** (atelier mécanique),
**La Fabrique Restaurant**, **Le Bar L'Usine**, **SCI Mapo** (immobilier).

## Fonctionnalités

- **Board d'agents IA** : 50 agents en graphe interactif. Le CEO de la holding au centre ; son board
  (CFO, Moneymaker, CMO, CTO, Stratège, Avocat du diable, Knowledge keeper) ; un directeur IA par
  société, chacun avec son équipe (un agent par métier). On clique un agent pour voir son rôle, son
  équipe, ses outils, et le **convoquer** : il lit les vraies données financières, consulte au besoin
  les agents de son équipe et rend une réponse avec les actions chiffrées. Historique des passages.
- **Directeurs financiers (DAF)** : un par société, rattachés au CFO du groupe qui les contrôle.
  **Chaque matin** (7 h, heure de Paris), automatiquement : synchronisation des banques et de la
  facturation, rapprochement, **relances clients** (J+3 courtoise, J+15 ferme, J+30 dernière
  relance), rapport de chaque DAF (« ✅ gagne / ❌ perd de l'argent » en première ligne, trésorerie,
  mouvements anormaux, impayés, 3 actions), puis **revue du CFO** qui vérifie les DAF et fait
  remonter les 3 décisions à prendre. Visible dans *Finances → Contrôle quotidien*.
- **Finances** : trésorerie consolidée et par société, entrées / sorties, dépenses par catégorie,
  factures clients et fournisseurs, retards de paiement, rapprochement automatique banque ↔ factures,
  import de relevés CSV / Excel de n'importe quelle banque.
- **Connexions** : **Shine** (compte pro + factures Shine Facture) se branche avec le bouton « Se connecter
  avec Shine » de chaque société (API officielle Shine Connect, lecture seule). Qonto, Stripe et Pennylane
  se branchent avec une clé API. Identifiants chiffrés en base, synchronisation automatique. Autres banques : import CSV en attendant un agrégateur (Bridge, Powens).
- **Accès** : le fondateur a tous les droits ; il peut créer des accès « membre » en consultation
  (associés, expert-comptable).

Les agents n'ont accès aux données qu'en **lecture seule** : ils proposent, ils n'exécutent aucun paiement.

## Sécurité

- **Double authentification obligatoire** (code à 6 chiffres d'une application Google / Microsoft
  Authenticator ou Authy) pour toute action sensible : banques, documents, accès, agents, relances.
- **Blocage** après 5 échecs de connexion en 15 minutes (par email et par adresse IP).
- Sessions de **8 heures** maximum ; un compte désactivé perd l'accès immédiatement.
- Mots de passe de 12 caractères minimum, hachés (bcrypt).
- **Chiffrement** AES-256-GCM des accès bancaires / logiciels et de **tous les documents** archivés
  (clé dérivée de `AUTH_SECRET`, jamais stockée).
- **Journal de sécurité** (page Accès) : connexions, échecs, accès bancaires, dépôts et téléchargements
  de documents, convocations des agents...
- En-têtes de sécurité (HSTS, CSP, anti-iframe), conteneur Docker sans privilèges root.
- Accès bancaires et agents en **lecture seule** : aucun paiement ne peut être déclenché.

À faire en production : HTTPS obligatoire, `AUTH_SECRET` de 32 caractères ou plus, volume `/app/data`
sauvegardé chaque jour, limite de dépense sur la clé Claude, et dépôt GitHub **privé**.

## Mise en route

La page **Mise en route** vérifie tout ce qui doit être branché (sécurité, clés, banque, factures,
bilans, relevés, relances) et affiche, société par société, ce qui manque encore.

## Archives (historique pour les agents)

Déposez dans **Archives** les bilans (PDF) et les relevés bancaires (PDF, CSV ou Excel) de chaque
société, ainsi que les exports de factures (CSV / Excel) de n'importe quel logiciel. L'IA lit les PDF :
chiffres clés de chaque exercice pour les bilans, opérations pour les relevés (importées sans doublon
avec la synchronisation Shine). Les directeurs financiers et le CFO s'en servent pour comparer chaque
mois à l'historique.

## Lancer en local

Prérequis : Node.js 20+.

```bash
npm install
cp .env.example .env      # puis renseignez AUTH_SECRET (openssl rand -base64 32)
npm run db:push
npm run db:seed           # sociétés du groupe + compte fondateur
npm run dev               # http://localhost:3000
```

Connexion : `ADMIN_EMAIL` / `ADMIN_PASSWORD` (par défaut `admin@start-invest.fr` / `startinvest2026`)
— **changez le mot de passe** dans *Accès* dès la première connexion.

## Mise en ligne sur Railway (10 minutes, sans ligne de commande)

L'application se configure seule : clé secrète générée au premier démarrage et conservée dans le
volume, adresse publique déduite du domaine Railway, base de données créée puis mise à jour à chaque
nouvelle version, droits du volume réglés automatiquement.

1. **railway.com** → *New Project* → *Deploy from GitHub repo* → `application-podiocom`.
2. Dans le service créé → **Settings** :
   - *Source* → **Root Directory** : `start-invest` ;
   - *Source* → **Branch** : `claude/bank-billing-integration-2ppnaz` (tant que ce n'est pas fusionné) ;
   - *Networking* → **Generate Domain** (port `3000`).
3. Clic droit sur le service → **Attach volume** → chemin **`/app/data`**. Indispensable : sans
   volume, tout est effacé à chaque déploiement. Activez les sauvegardes du volume.
4. **Variables** → ajoutez (valeurs saisies uniquement dans Railway) :
   - `ANTHROPIC_API_KEY` — clé Claude (console.anthropic.com), avec une limite de dépense ;
   - facultatif : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` pour envoyer les relances.
5. Attendez le déploiement, ouvrez l'adresse, connectez-vous (`admin@start-invest.fr` /
   `startinvest2026`), puis suivez la page **Mise en route**.

Chez Shine, l'adresse de retour à déclarer est `https://<votre-domaine-railway>/api/shine/callback`.
Gardez **une seule instance** (le planificateur du contrôle quotidien tourne dans l'application).

Autre hébergeur (VPS + Docker) : `docker compose up -d --build` avec un volume sur `/app/data` ;
définissez alors `NEXTAUTH_URL=https://votre-domaine` (et `AUTH_SECRET` si vous le souhaitez).

**Synchronisation automatique** : appelez toutes les heures `GET /api/cron/sync` avec l'en-tête
`Authorization: Bearer <CRON_SECRET>` (cron Railway, cron-job.org...).

## Brancher Shine

Shine se connecte via son serveur officiel pour assistants IA (MCP, Shine Facture) : aucune clé à
demander à Shine. Dans *Connexions*, cliquez « Se connecter avec Shine » pour chaque société et
connectez-vous avec l'identifiant Shine de la société (offre Start ou Plus requise). La connexion
dure 30 jours, puis il faut la refaire (la page Mise en route le signale).

- Synchronisation vers Finances : factures clients, factures fournisseurs, lignes bancaires.
- Les directeurs financiers, le CFO et le CEO interrogent aussi Shine **en direct**, avec les seuls
  outils de lecture (aucune création ni modification dans Shine).

## Contrôle quotidien et relances

- Le planificateur est intégré à l'application (serveur toujours allumé : Docker / Railway / VPS) :
  synchronisation toutes les heures, contrôle complet chaque jour à `DAILY_CONTROL_HOUR` (défaut 7 h).
  Bouton « Lancer le contrôle maintenant » dans *Finances*. Alternative : `SCHEDULER=off` et appel
  externe de `GET /api/cron/daily` (en-tête `Authorization: Bearer <CRON_SECRET>`).
- **Relances** : à activer société par société dans *Finances → Relances automatiques*. Elles partent
  par e-mail si `SMTP_HOST` / `SMTP_FROM` (et `SMTP_USER` / `SMTP_PASS`) sont définis et que l'e-mail du
  client est connu (récupéré depuis Pennylane, ou saisi sur la facture) ; sinon elles sont préparées en
  brouillon, envoyables d'un clic.
- Coût : le contrôle quotidien fait travailler 5 DAF + le CFO sur l'API Claude chaque jour.
- Les virements entre sociétés du groupe (libellés « virement interne », « vir vers SCI Mapo »...) sont
  exclus du calcul « gagne / perd ».

## Les agents

Chaque agent est un fichier `.claude/agents/<nom>.md` (format des sous-agents Claude Code, donc aussi
utilisables dans Claude Code). En-tête : `name`, `description`, `model`, `tools`, et pour le board
`title`, `parent` (qui le dirige), `structure` (société), `skills`, `works_with`. Le texte en dessous
est son mode d'emploi.

- **Ajouter une société** : créez `dg-<nom>.md` avec `parent: ceo` et `structure: <Nom>`, ses agents
  avec `parent: dg-<nom>`, puis ajoutez la société dans *Finances*.
- Chaque convocation consomme des crédits API Claude (modèle Claude Opus 5.5 ; une demande au CEO,
  qui consulte plusieurs agents, coûte plus qu'une demande directe à un agent).

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS · Prisma (SQLite) · NextAuth v5 · SDK Anthropic.
