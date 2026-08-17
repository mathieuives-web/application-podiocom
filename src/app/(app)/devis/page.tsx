import { prisma } from "@/lib/prisma";
import { requireStaff } from "@/lib/session";
import { uploadQuote, replaceQuoteFile, deleteQuote } from "./actions";

const fmt = (d: Date) => new Date(d).toLocaleString("fr-FR");

export default async function DevisPage() {
  await requireStaff();

  const [quotes, vehicles] = await Promise.all([
    prisma.quote.findMany({ orderBy: { uploadedAt: "desc" }, include: { vehicle: true } }),
    prisma.vehicle.findMany({ where: { active: true }, orderBy: { plate: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Devis de prestation</h1>
        <p className="text-sm text-slate-500">
          Chargez le dossier Excel du devis (toutes les infos pour chiffrer la prestation). Vous pourrez le
          remplacer facilement en cas de modification.
        </p>
      </div>

      <div className="card">
        <p className="font-semibold mb-3">+ Charger un nouveau devis</p>
        <form action={uploadQuote} className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="label">Titre du devis *</label>
            <input name="title" className="input" required placeholder="Ex: Devis révision moteur - Tracteur 3" />
          </div>
          <div>
            <label className="label">Véhicule concerné (optionnel)</label>
            <select name="vehicleId" className="input" defaultValue="">
              <option value="">— non lié —</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.plate} {v.name ? `— ${v.name}` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Fichier Excel *</label>
            <input name="file" type="file" accept=".xlsx,.xls,.csv" className="input" required />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary" type="submit">Charger le devis</button>
          </div>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Titre</th>
              <th>Véhicule</th>
              <th>Fichier</th>
              <th>Chargé le</th>
              <th>Remplacer</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td>{q.title}</td>
                <td className="font-mono">{q.vehicle?.plate ?? "—"}</td>
                <td>
                  <a href={q.filePath} target="_blank" rel="noreferrer" className="underline">
                    {q.fileName}
                  </a>
                </td>
                <td>{fmt(q.uploadedAt)}</td>
                <td>
                  <form
                    action={async (formData: FormData) => {
                      "use server";
                      await replaceQuoteFile(q.id, formData);
                    }}
                    className="flex items-center gap-2"
                  >
                    <input type="file" name="file" accept=".xlsx,.xls,.csv" className="text-xs" required />
                    <button className="btn-secondary text-xs" type="submit">Remplacer</button>
                  </form>
                </td>
                <td>
                  <form
                    action={async () => {
                      "use server";
                      await deleteQuote(q.id);
                    }}
                  >
                    <button className="text-xs text-red-500 underline" type="submit">supprimer</button>
                  </form>
                </td>
              </tr>
            ))}
            {quotes.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-6">Aucun devis chargé.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
