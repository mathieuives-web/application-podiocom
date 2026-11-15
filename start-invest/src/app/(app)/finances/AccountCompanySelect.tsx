"use client";

import { useTransition } from "react";

/** Menu « Société » d'un compte : enregistre dès qu'on choisit (pas de bouton à cliquer). */
export default function AccountCompanySelect({
  accountId,
  value,
  companies,
  action,
}: {
  accountId: string;
  value: string;
  companies: { id: string; name: string }[];
  action: (accountId: string, formData: FormData) => Promise<void>;
}) {
  const [pending, start] = useTransition();
  return (
    <span className="flex items-center gap-2">
      <select
        key={value}
        defaultValue={value}
        disabled={pending}
        className="input py-1 text-xs"
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__exclure__" && !confirm("Exclure ce compte ? Ses opérations seront supprimées et ne seront plus importées.")) {
            e.target.value = value;
            return;
          }
          const fd = new FormData();
          fd.set("companyId", v);
          start(() => action(accountId, fd));
        }}
      >
        {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__exclure__">Exclure (compte personnel)</option>
      </select>
      <span className="text-xs text-slate-400 w-16">{pending ? "enregistre…" : ""}</span>
    </span>
  );
}
