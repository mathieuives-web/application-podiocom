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

## Mise en ligne

Même principe que l'application Podiocom : image Docker fournie (Railway, ou VPS avec Caddy pour le
HTTPS). Un volume persistant monté sur `/app/data` conserve la base. Variables à définir :
`AUTH_SECRET`, `AUTH_TRUST_HOST=true`, `NEXTAUTH_URL`, `ANTHROPIC_API_KEY`, et éventuellement
`ADMIN_EMAIL` / `ADMIN_PASSWORD` (premier lancement) et `CRON_SECRET`.

**Synchronisation automatique** : appelez toutes les heures `GET /api/cron/sync` avec l'en-tête
`Authorization: Bearer <CRON_SECRET>` (cron Railway, cron-job.org...).

## Brancher Shine

1. Demander l'accès Shine Connect (une fois pour tout le groupe) via le formulaire
   https://tally.so/r/3qAy69 — accès demandés : `bank:accounts:read`, `bank:transactions:read`,
   `invoices:read` ; adresse de retour : `https://votre-domaine/api/shine/callback`.
2. Ajouter sur le serveur `SHINE_CLIENT_ID` et `SHINE_CLIENT_SECRET` reçus de Shine.
3. Dans *Connexions*, cliquer « Se connecter avec Shine » pour chaque société et accepter avec le compte
   Shine de la société.

Les factures Shine Facture dont la relance Shine est activée ne sont pas relancées une deuxième fois par
l'application (pas de double relance). Le montant TTC est recalculé à partir des lignes de la facture et
l'échéance à partir du délai de paiement.

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
