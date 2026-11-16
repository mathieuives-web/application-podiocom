"use client";

import { useState } from "react";

/** Crée 10 codes de secours et les affiche UNE seule fois (à prendre en photo ou à imprimer). */
export default function RecoveryCodes({ action, left }: { action: () => Promise<string[]>; left: number }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      {codes ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-red-700">Notez-les maintenant (photo, papier) : ils ne seront plus jamais affichés.</p>
          <ol className="grid grid-cols-2 gap-1 font-mono text-sm bg-white border rounded p-3">
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ol>
          <button type="button" className="btn-secondary text-xs" onClick={() => window.print()}>Imprimer</button>
        </div>
      ) : (
        <>
          <p className="text-sm text-slate-600">{left ? `${left} code(s) de secours encore valables.` : "Aucun code de secours : créez-en pour pouvoir vous dépanner seul en cas d'oubli du mot de passe."}</p>
          <button
            type="button"
            disabled={busy}
            className="btn-primary"
            onClick={async () => {
              if (left && !confirm("Créer de nouveaux codes annule les anciens. Continuer ?")) return;
              setBusy(true);
              setCodes(await action());
              setBusy(false);
            }}
          >
            {left ? "Créer de nouveaux codes" : "Créer mes 10 codes de secours"}
          </button>
        </>
      )}
    </div>
  );
}
