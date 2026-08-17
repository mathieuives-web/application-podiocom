import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// Stockage local des fichiers (photos, fiches techniques, devis, tickets...).
// NB: sur un hébergement serverless (Vercel, etc.) le système de fichiers est
// éphémère. Pour la production, hébergez sur un serveur avec disque persistant
// (VPS, Railway, Render) ou remplacez ces fonctions par un client S3 /
// équivalent (voir README.md, section "Stockage des fichiers en production").

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");

export async function saveUploadedFile(
  file: File,
  subdir: string
): Promise<{ filePath: string; fileName: string }> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const dir = path.join(UPLOAD_ROOT, subdir);
  await mkdir(dir, { recursive: true });
  const ext = path.extname(file.name) || guessExt(file.type);
  const safeName = `${randomUUID()}${ext}`;
  await writeFile(path.join(dir, safeName), bytes);
  return { filePath: `/uploads/${subdir}/${safeName}`, fileName: file.name || safeName };
}

function guessExt(mime: string) {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "application/pdf") return ".pdf";
  return "";
}
