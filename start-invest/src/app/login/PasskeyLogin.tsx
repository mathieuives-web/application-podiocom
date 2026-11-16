"use client";

import { useRef, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

/** Bouton Face ID / empreinte : l'appareil signe le défi, puis le formulaire est envoyé au serveur qui vérifie. */
export default function PasskeyLogin({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <form ref={form} action={action} className="space-y-2">
      <input ref={input} type="hidden" name="response" />
      <button
        type="button"
        disabled={busy}
        className="btn-primary w-full py-3 text-base"
        style={{ background: "#7f1d1d" }}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const options = await fetch("/api/passkey/login-options", { method: "POST" }).then((r) => r.json());
            const response = await startAuthentication(options);
            input.current!.value = JSON.stringify(response);
            form.current!.requestSubmit();
          } catch (e) {
            const msg = (e as Error).message ?? "";
            setError(/cancel|abort|NotAllowed/i.test(msg) ? "Connexion annulée." : "Face ID indisponible sur cet appareil : utilisez le mot de passe.");
            setBusy(false);
          }
        }}
      >
        {busy ? "Vérification…" : "Se connecter avec Face ID / empreinte"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
