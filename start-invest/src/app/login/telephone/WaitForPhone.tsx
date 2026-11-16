"use client";

import { useEffect, useRef, useState } from "react";

/** Interroge le serveur toutes les 2 s ; dès que le téléphone a approuvé, termine la connexion. */
export default function WaitForPhone({ action }: { action: () => Promise<void> }) {
  const [state, setState] = useState("PENDING");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const s = await fetch("/api/connexion-pc/statut", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ status: "PENDING" }));
      setState(s.status);
      if (s.status === "APPROVED") {
        stop = true;
        form.current?.requestSubmit();
      } else if (s.status === "PENDING") setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);
  return (
    <form ref={form} action={action}>
      <p className={`text-sm ${state === "DENIED" || state === "EXPIRED" ? "text-red-600" : "text-slate-500"}`}>
        {state === "APPROVED" ? "✅ Approuvé, connexion…" : state === "DENIED" ? "Connexion refusée depuis le téléphone." : state === "EXPIRED" ? "Délai dépassé (3 minutes) : recommencez." : "En attente du téléphone…"}
      </p>
    </form>
  );
}
