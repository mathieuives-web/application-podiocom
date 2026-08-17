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

const CAMERA_TIMEOUT_MS = 10000;

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
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function startCamera() {
    setError(null);
    setCameraReady(false);

    if (typeof window === "undefined" || !window.isSecureContext) {
      setError(
        "La caméra nécessite une connexion sécurisée (https). Utilisez plutôt «Depuis un fichier»."
      );
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        "Votre navigateur ne permet pas la capture directe. Utilisez plutôt «Depuis un fichier»."
      );
      return;
    }

    setCameraLoading(true);
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        }),
        CAMERA_TIMEOUT_MS
      );
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await withTimeout(videoRef.current.play(), CAMERA_TIMEOUT_MS);
      }
      setCameraReady(true);
    } catch (err) {
      stopCamera();
      setError(describeCameraError(err));
    } finally {
      setCameraLoading(false);
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraReady(false);
  }

  function takeSnapshot() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setError("La caméra n'est pas encore prête. Patientez un instant puis réessayez.");
      return;
    }
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
    setError(null);
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
          />
          <p className="text-xs text-slate-500 mt-1">
            Sur téléphone, vous pourrez choisir « Appareil photo » ou « Galerie » dans le sélecteur.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {!preview && (
            <div className="relative">
              <video
                ref={videoRef}
                className="w-full rounded-md bg-black aspect-video"
                muted
                playsInline
                autoPlay
              />
              {cameraLoading && (
                <div className="absolute inset-0 flex items-center justify-center text-white text-sm bg-black/40 rounded-md">
                  Ouverture de la caméra... autorisez l&apos;accès si demandé.
                </div>
              )}
            </div>
          )}
          {preview && <img src={preview} alt="Aperçu" className="w-full rounded-md" />}
          <div className="flex gap-2">
            {!preview && (
              <button
                type="button"
                className="btn-secondary"
                onClick={takeSnapshot}
                disabled={cameraLoading || !cameraReady}
              >
                Capturer
              </button>
            )}
            {!preview && (
              <button type="button" className="btn-secondary" onClick={startCamera} disabled={cameraLoading}>
                {cameraLoading ? "Connexion..." : "Réessayer"}
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException("La caméra met trop de temps à répondre.", "TimeoutError"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function describeCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Accès à la caméra refusé. Autorisez la caméra pour ce site dans les réglages du navigateur, puis réessayez.";
    }
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      return "Aucune caméra détectée sur cet appareil. Utilisez plutôt «Depuis un fichier».";
    }
    if (err.name === "TimeoutError") {
      return "La caméra met trop de temps à répondre. Vérifiez qu'aucune autre application ne l'utilise, puis réessayez.";
    }
    if (err.name === "NotReadableError") {
      return "La caméra est déjà utilisée par une autre application.";
    }
  }
  return "Impossible d'accéder à la caméra. Vérifiez les autorisations du navigateur, ou utilisez «Depuis un fichier».";
}
