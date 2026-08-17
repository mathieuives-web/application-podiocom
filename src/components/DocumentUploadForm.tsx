"use client";

import { useRef, useState, useTransition } from "react";

type Option = { value: string; label: string };

type Props = {
  action: (formData: FormData) => Promise<void>;
  typeOptions: Option[];
  hidden?: Record<string, string>;
  submitLabel?: string;
  noteLabel?: string;
  title?: string;
};

export default function DocumentUploadForm({
  action,
  typeOptions,
  hidden,
  submitLabel = "Ajouter",
  noteLabel = "Note / montant (optionnel)",
  title,
}: Props) {
  const [mode, setMode] = useState<"file" | "camera">("file");
  const [preview, setPreview] = useState<string | null>(null);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setError("Impossible d'accéder à la caméra. Vérifiez les autorisations du navigateur.");
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function takeSnapshot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setCapturedFile(file);
        setPreview(URL.createObjectURL(blob));
        stopCamera();
      },
      "image/jpeg",
      0.9
    );
  }

  function switchMode(next: "file" | "camera") {
    setMode(next);
    setCapturedFile(null);
    setPreview(null);
    if (next === "camera") startCamera();
    else stopCamera();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const formData = new FormData(formEl);

    if (mode === "camera") {
      if (!capturedFile) {
        setError("Prenez d'abord une photo.");
        return;
      }
      formData.set("file", capturedFile);
    } else if (!fileInputRef.current?.files?.[0]) {
      setError("Choisissez un fichier.");
      return;
    }

    startTransition(async () => {
      await action(formData);
      formEl.reset();
      setCapturedFile(null);
      setPreview(null);
      stopCamera();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 card">
      {title && <p className="font-semibold text-sm">{title}</p>}
      {hidden &&
        Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}

      <div className="flex gap-2 text-sm">
        <button
          type="button"
          onClick={() => switchMode("file")}
          className={mode === "file" ? "btn-primary" : "btn-secondary"}
        >
          Depuis un fichier
        </button>
        <button
          type="button"
          onClick={() => switchMode("camera")}
          className={mode === "camera" ? "btn-primary" : "btn-secondary"}
        >
          Appareil photo
        </button>
      </div>

      <div>
        <label className="label">Type de document</label>
        <select name="type" className="input" required defaultValue={typeOptions[0]?.value}>
          {typeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {mode === "file" ? (
        <div>
          <label className="label">Fichier (photo, PDF...)</label>
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="image/*,application/pdf"
            className="input"
            capture="environment"
          />
        </div>
      ) : (
        <div className="space-y-2">
          {!preview && (
            <video ref={videoRef} className="w-full rounded-md bg-black aspect-video" muted playsInline />
          )}
          {preview && <img src={preview} alt="Aperçu" className="w-full rounded-md" />}
          <div className="flex gap-2">
            {!preview && (
              <button type="button" className="btn-secondary" onClick={takeSnapshot}>
                Capturer
              </button>
            )}
            {preview && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setPreview(null);
                  setCapturedFile(null);
                  startCamera();
                }}
              >
                Reprendre
              </button>
            )}
          </div>
        </div>
      )}

      <div>
        <label className="label">{noteLabel}</label>
        <input type="text" name="note" className="input" placeholder="Ex: plein gasoil - 85 000 FCFA" />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Envoi..." : submitLabel}
      </button>
    </form>
  );
}
