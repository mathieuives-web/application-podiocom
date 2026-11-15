"use client";

import { useState } from "react";

/** Choix de la banque + bouton : navigation directe (pas de formulaire) vers la page d'autorisation. */
export default function BankConnect({ companyId, banks, initial }: { companyId: string; banks: string[]; initial: string }) {
  const [bank, setBank] = useState(initial);
  const [going, setGoing] = useState(false);
  return (
    <>
      <select className="input py-1 text-xs flex-1 min-w-40" value={bank} onChange={(e) => setBank(e.target.value)}>
        <option value="">Banque…</option>
        {banks.map((b) => <option key={b} value={b}>{b}</option>)}
      </select>
      <button
        type="button"
        className="btn-primary text-xs"
        disabled={!bank || going}
        onClick={() => {
          setGoing(true);
          window.location.assign(`/api/banque/connect?companyId=${encodeURIComponent(companyId)}&bank=${encodeURIComponent(bank)}`);
        }}
      >
        {going ? "Ouverture de la banque…" : "Connecter la banque"}
      </button>
    </>
  );
}
