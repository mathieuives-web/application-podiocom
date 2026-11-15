"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { DOC_TYPES, deleteDocument, processDocument, saveDocument, type DocType } from "@/lib/documents";
import { prisma } from "@/lib/prisma";
import { runFullAnalysis } from "@/lib/daily-control";

export async function uploadDocuments(formData: FormData) {
  const me = await requireAdmin();
  const companyId = String(formData.get("companyId") ?? "");
  const type = String(formData.get("type") ?? "AUTRE") as DocType;
  if (!(type in DOC_TYPES)) throw new Error("Type de document inconnu.");
  const yearRaw = Number(formData.get("year"));
  const accountId = String(formData.get("accountId") ?? "") || null;
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) redirect("/archives?msg=" + encodeURIComponent("Choisissez au moins un fichier."));
  if (type === "RELEVE" && !accountId) redirect("/archives?msg=" + encodeURIComponent("Choisissez le compte bancaire du relevé."));
  if (accountId) {
    const acc = await prisma.bankAccount.findUnique({ where: { id: accountId } });
    if (!acc || acc.companyId !== companyId) redirect("/archives?msg=" + encodeURIComponent("Ce compte n'appartient pas à cette société."));
  }

  const queued: string[] = [];
  const problems: string[] = [];
  for (const f of files) {
    try {
      const { doc, duplicate } = await saveDocument(f, {
        companyId,
        type,
        year: Number.isFinite(yearRaw) && yearRaw > 1990 ? yearRaw : null,
        accountId,
        uploadedBy: me.email,
      });
      if (duplicate) problems.push(`${f.name} : déjà déposé`);
      else queued.push(doc.id);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  await audit(me, "documents_deposes", `${queued.length} fichier(s) ${type} — société ${companyId}`);
  // Lecture par l'IA en arrière-plan, un document à la fois.
  after(async () => {
    for (const id of queued) await processDocument(id);
    // Dès que les documents sont lus, le directeur financier de la société analyse tout l'historique.
    if (queued.length) await runFullAnalysis(companyId, me.id).catch((e) => console.error("[analyse]", e));
  });
  revalidatePath("/archives");
  const msg = `${queued.length} document(s) déposé(s) et en cours de lecture.${problems.length ? " " + problems.join(" · ") : ""}`;
  redirect("/archives?msg=" + encodeURIComponent(msg));
}

export async function reprocessDocument(id: string) {
  const me = await requireAdmin();
  await audit(me, "document_relu", id);
  after(() => processDocument(id));
  revalidatePath("/archives");
}

export async function removeDocument(id: string) {
  const me = await requireAdmin();
  const doc = await prisma.document.findUniqueOrThrow({ where: { id } });
  await audit(me, "document_supprime", doc.fileName);
  await deleteDocument(id);
  revalidatePath("/archives");
}

export async function launchAnalysis(companyId: string) {
  const me = await requireAdmin();
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  await audit(me, "analyse_complete_lancee", company.name);
  after(() => runFullAnalysis(companyId, me.id).then(() => undefined).catch((e) => console.error("[analyse]", e)));
  redirect("/archives?msg=" + encodeURIComponent(`Analyse complète de ${company.name} lancée : le directeur financier lit tout l'historique (quelques minutes).`));
}
