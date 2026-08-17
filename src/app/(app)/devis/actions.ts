"use server";

import { unlink } from "fs/promises";
import path from "path";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { saveUploadedFile } from "@/lib/storage";

function str(v: FormDataEntryValue | null) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

async function removeFileQuiet(filePath: string) {
  try {
    await unlink(path.join(process.cwd(), "public", filePath));
  } catch {
    // fichier déjà absent, on ignore
  }
}

export async function uploadQuote(formData: FormData) {
  const user = await requireStaff();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return;

  const { filePath, fileName } = await saveUploadedFile(file, "devis");

  await prisma.quote.create({
    data: {
      title: str(formData.get("title")) ?? fileName,
      vehicleId: str(formData.get("vehicleId")),
      filePath,
      fileName,
      uploadedById: user.id,
    },
  });

  revalidatePath("/devis");
}

export async function replaceQuoteFile(quoteId: string, formData: FormData) {
  await requireStaff();
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return;

  const existing = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const { filePath, fileName } = await saveUploadedFile(file, "devis");
  await removeFileQuiet(existing.filePath);

  await prisma.quote.update({
    where: { id: quoteId },
    data: { filePath, fileName, uploadedAt: new Date() },
  });

  revalidatePath("/devis");
}

export async function deleteQuote(quoteId: string) {
  await requireStaff();
  const existing = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  await removeFileQuiet(existing.filePath);
  await prisma.quote.delete({ where: { id: quoteId } });
  revalidatePath("/devis");
}
