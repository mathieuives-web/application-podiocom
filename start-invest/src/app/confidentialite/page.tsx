export const metadata = { title: "Confidentialité — Start Invest" };

export default function Confidentialite() {
  return (
    <main className="max-w-2xl mx-auto p-6 space-y-4 text-sm text-slate-700">
      <h1 className="text-xl font-bold text-slate-900">Politique de confidentialité</h1>
      <p>
        Start Invest est un outil interne de pilotage financier réservé aux sociétés du groupe Start Invest et à leurs dirigeants.
        Il n&apos;est pas proposé au public.
      </p>
      <h2 className="font-semibold text-slate-900">Données traitées</h2>
      <p>
        Soldes et opérations des comptes bancaires professionnels des sociétés du groupe, obtenus en lecture seule avec
        l&apos;autorisation explicite de leur titulaire ; factures et documents comptables déposés par le groupe.
      </p>
      <h2 className="font-semibold text-slate-900">Finalité</h2>
      <p>Suivi de trésorerie, contrôle de gestion et analyse financière internes. Aucune revente, aucun usage publicitaire.</p>
      <h2 className="font-semibold text-slate-900">Sécurité</h2>
      <p>
        Accès protégé par mot de passe et double authentification, identifiants bancaires et documents chiffrés, journal des
        accès. Aucun paiement ne peut être initié depuis l&apos;outil.
      </p>
      <h2 className="font-semibold text-slate-900">Durée et droits</h2>
      <p>
        Les autorisations bancaires peuvent être retirées à tout moment auprès de la banque ou depuis l&apos;outil. Les données sont
        conservées le temps nécessaire au pilotage et aux obligations comptables du groupe.
      </p>
    </main>
  );
}
