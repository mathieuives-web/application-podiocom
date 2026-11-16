"use client";

import { useEffect, useRef, useState } from "react";

const W = 1280;
const H = 800;

/** Écran du navigateur distant : cliquez dessus et tapez au clavier comme sur votre propre ordinateur. */
export default function LiveBrowser({ sid }: { sid: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = (action: Record<string, unknown>) => {
    queue.current = queue.current.then(() =>
      fetch(`/api/robot/${sid}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) })
        .then(async (r) => (r.ok ? null : setError((await r.json().catch(() => ({}))).error ?? "Erreur")))
        .catch(() => setError("Connexion perdue"))
    );
    return queue.current;
  };

  const flushText = () => {
    if (buffer.current) {
      const text = buffer.current;
      buffer.current = "";
      void send({ type: "text", text });
    }
  };

  useEffect(() => {
    let alive = true;
    let last: string | null = null;
    const loop = async () => {
      while (alive) {
        try {
          await queue.current;
          const r = await fetch(`/api/robot/${sid}?t=${Date.now()}`, { cache: "no-store" });
          if (r.status === 410) {
            setError("La fenêtre s'est fermée (30 min sans activité ou mise à jour du serveur).");
            return;
          }
          if (r.ok) {
            const blob = await r.blob();
            const next = URL.createObjectURL(blob);
            setSrc(next);
            setUrl(decodeURI(r.headers.get("X-Page-Url") ?? ""));
            if (last) URL.revokeObjectURL(last);
            last = next;
          }
        } catch {
          /* réessaie */
        }
        await new Promise((res) => setTimeout(res, 700));
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [sid]);

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    flushText();
    const r = e.currentTarget.getBoundingClientRect();
    void send({ type: "click", x: Math.round(((e.clientX - r.left) / r.width) * W), y: Math.round(((e.clientY - r.top) / r.height) * H) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    if (e.key.length === 1) {
      e.preventDefault();
      buffer.current += e.key;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flushText, 250);
    } else if (["Enter", "Tab", "Backspace", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Delete"].includes(e.key)) {
      e.preventDefault();
      flushText();
      void send({ type: "key", key: e.key });
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    flushText();
    void send({ type: "text", text: e.clipboardData.getData("text").slice(0, 500) });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <button className="btn-secondary text-xs" onClick={() => send({ type: "back" })}>← Retour</button>
        <button className="btn-secondary text-xs" onClick={() => send({ type: "scroll", dy: -500 })}>▲ Monter</button>
        <button className="btn-secondary text-xs" onClick={() => send({ type: "scroll", dy: 500 })}>▼ Descendre</button>
        <span className="text-slate-500 truncate max-w-md">{url}</span>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`relative border-2 rounded-md overflow-hidden outline-none ${focused ? "border-emerald-600" : "border-slate-300"}`}
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={imgRef} src={src} alt="Écran du site" onClick={onClick} className="w-full h-full cursor-pointer select-none" draggable={false} />
        ) : (
          <p className="p-6 text-sm text-slate-500">Ouverture du site…</p>
        )}
        {!focused && src && <p className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">Cliquez dans l&apos;écran, puis tapez au clavier</p>}
      </div>
    </div>
  );
}
