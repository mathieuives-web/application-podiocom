"use client";

import { useTransition } from "react";

const KINDS = [
  { v: "COURANT", label: "Courant (trésorerie)" },
  { v: "SEQUESTRE", label: "Séquestre (fonds de tiers)" },
  { v: "PRET", label: "Prêt / crédit" },
];

/** Menu « Type » d'un compte : enregistre dès qu'on choisit. */
export default function AccountKindSelect({
  accountId,
  value,
  action,
}: {
  accountId: string;
  value: string;
  action: (accountId: string, formData: FormData) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  return (
    <select
      key={value}
      defaultValue={value}
      disabled={pending}
      className="input py-1 text-xs"
      onChange={(e) => {
        const fd = new FormData();
        fd.set("kind", e.target.value);
        start(() => action(accountId, fd));
      }}
    >
      {KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
    </select>
  );
}
