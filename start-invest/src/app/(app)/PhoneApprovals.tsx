"use client";

import { useEffect, useState } from "react";

type Req = { id: string; code: string; ip: string | null; device: string | null; createdAt: string };

/** Bandeau sur le téléphone : une connexion est demandée sur un ordinateur, l'approuver avec Face ID. */
export default function PhoneApprovals() {
  const [reqs, setReqs] = useState<Req[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      if (document.visibilityState === "visible") {
        const r = await fetch("/api/connexion-pc/demandes", { cache: "no-store" }).then((x) => (x.ok ? x.json() : [])).catch(() => []);
        if (alive) setReqs(r);
      }
      setTimeout(tick, 4000);
    };
    tick();
    return () => {
      alive = false;
    };
  }, []);
  if (!reqs.length && !msg) return null;
  const decide = async (r: Req, approve: boolean) => {
    try {
      const res = await fetch("/api/connexion-pc/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id, approve }) }).then((x) => x.json());
      setMsg(res.ok ? (approve ? "✅ Connexion approuvée sur l'autre appareil." : "Connexion refusée.") : res.error ?? "Échec.");
      setReqs((x) => x.filter((y) => y.id !== r.id));
      setTimeout(() => setMsg(null), 6000);
    } catch {
      setMsg("Échec : réessayez.");
    }
  };
  return (
    <div className="fixed top-14 md:top-4 inset-x-3 md:left-auto md:right-4 md:w-96 z-40 space-y-2">
      {reqs.map((r) => (
        <div key={r.id} className="rounded-xl bg-amber-50 border border-amber-300 shadow-lg p-4 text-sm space-y-2">
          <p className="font-semibold">Connexion demandée sur un autre appareil</p>
          <p className="text-slate-700">{r.device ?? "Appareil"}{r.ip ? ` · ${r.ip}` : ""} · code <b className="text-lg">{r.code}</b></p>
          <p className="text-xs text-slate-500">Approuvez seulement si c&apos;est vous et si le même code s&apos;affiche sur l&apos;ordinateur.</p>
          <div className="flex gap-2">
            <button className="btn-primary flex-1" style={{ background: "#047857" }} onClick={() => decide(r, true)}>Approuver</button>
            <button className="btn-secondary flex-1" onClick={() => decide(r, false)}>Refuser</button>
          </div>
        </div>
      ))}
      {msg && <p className="rounded-xl bg-white border shadow p-3 text-sm">{msg}</p>}
    </div>
  );
}
