"use client";

import { useState } from "react";

/** Crée la clé du récapitulatif de Claude et l'affiche UNE fois, avec un bouton pour la copier. */
export default function RecapKey({ action, exists }: { action: () => Promise<string>; exists: boolean }) {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  return key ? (
    <div className="space-y-2">
      <p className="text-sm font-medium text-red-700">Copiez-la maintenant et collez-la dans le formulaire sécurisé de Claude (jamais dans une conversation). Elle ne sera plus affichée.</p>
      <code className="block break-all bg-white border rounded p-2 text-sm">{key}</code>
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={async () => {
          await navigator.clipboard.writeText(key).catch(() => undefined);
          setCopied(true);
        }}
      >
        {copied ? "Copiée ✅" : "Copier la clé"}
      </button>
    </div>
  ) : (
    <div className="space-y-2">
      <p className="text-sm text-slate-600">
        {exists ? "Une clé existe déjà. En créer une nouvelle annule l'ancienne." : "Aucune clé : Claude ne peut pas lire votre récapitulatif."} La clé ne permet que de LIRE le
        récapitulatif (activité des agents, grands chiffres, surveillance) : aucun mot de passe, IBAN ni détail d&apos;opération.
      </p>
      <button
        type="button"
        className="btn-primary"
        onClick={async () => {
          if (exists && !confirm("Créer une nouvelle clé annule l'ancienne. Continuer ?")) return;
          setKey(await action());
        }}
      >
        Créer la clé du récapitulatif
      </button>
    </div>
  );
}
