"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";

/** Active Face ID / empreinte / code du téléphone sur l'appareil utilisé. */
export default function PasskeyRegister() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={busy}
        className="btn-primary"
        style={{ background: "#047857" }}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const options = await fetch("/api/passkey/register-options", { method: "POST" }).then((r) => r.json());
            const response = await startRegistration(options);
            const name = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Téléphone Android" : /Mac/.test(navigator.userAgent) ? "Mac" : /Windows/.test(navigator.userAgent) ? "PC Windows" : "Appareil";
            const r = await fetch("/api/passkey/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response, name }) }).then((x) => x.json());
            setMsg(r.ok ? "✅ Activé : à la prochaine connexion, un seul geste suffit." : `Échec : ${r.error}`);
            router.refresh();
          } catch (e) {
            const m = (e as Error).message ?? "";
            setMsg(/cancel|abort|NotAllowed/i.test(m) ? "Annulé." : /exclude|already|InvalidState/i.test(m) ? "Cet appareil est déjà activé." : "Cet appareil ne permet pas Face ID / empreinte ici.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "En attente du visage / de l'empreinte…" : "Activer Face ID / empreinte sur cet appareil"}
      </button>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
