import * as XLSX from "xlsx";

// Lecture des relevés bancaires exportés depuis n'importe quelle banque (CSV, XLS, XLSX).
// Colonnes reconnues : Date, Libellé/Description, Montant OU Débit + Crédit.

export type ParsedLine = { date: Date; label: string; amount: number };

function parseAmount(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (v === null || v === undefined) return null;
  let s = String(v).replace(/[\s  €]/g, "").replace(/EUR/i, "");
  if (!s) return null;
  // "1.234,56" ou "1234,56" -> 1234.56 ; "1,234.56" -> 1234.56
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return new Date(Date.UTC(d.y, d.m - 1, d.d, 12));
  }
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 12));
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return null;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export async function parseStatement(file: File): Promise<ParsedLine[]> {
  return parseStatementBuffer(Buffer.from(await file.arrayBuffer()), file.name, file.type);
}

/** Lit un tableur (CSV / XLS / XLSX) et renvoie ses lignes brutes, en-têtes compris. */
export function readSheet(buf: Buffer, name: string, mime = ""): unknown[][] {
  let wb: XLSX.WorkBook;
  if (/\.(csv|txt)$/i.test(name) || mime === "text/csv") {
    let text = buf.toString("utf8");
    if (text.includes("\ufffd")) text = buf.toString("latin1");
    const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
    const FS = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : first.includes("\t") ? "\t" : ",";
    wb = XLSX.read(text, { type: "string", FS, raw: true });
  } else {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  }
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });
}

export { parseAmount, parseDate };

export function parseStatementBuffer(buf: Buffer, name: string, mime = ""): ParsedLine[] {
  let wb: XLSX.WorkBook;
  if (/\.(csv|txt)$/i.test(name) || mime === "text/csv") {
    let text = buf.toString("utf8");
    if (text.includes("�")) text = buf.toString("latin1");
    const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
    const FS = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ";" : first.includes("\t") ? "\t" : ",";
    wb = XLSX.read(text, { type: "string", FS, raw: true });
  } else {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: true });

  // Cherche la ligne d'en-tête dans les 20 premières lignes.
  let headerIdx = -1;
  let col = { date: -1, label: -1, amount: -1, debit: -1, credit: -1 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const h = (rows[i] as unknown[]).map((c) => norm(String(c)));
    const find = (re: RegExp) => h.findIndex((c) => re.test(c));
    const c = {
      date: find(/^date( (d.)?operation| comptable)?$|^date/),
      label: find(/libelle|label|description|intitule|operation|detail|motif/),
      amount: find(/^montant|amount|^somme/),
      debit: find(/debit/),
      credit: find(/credit/),
    };
    if (c.date >= 0 && c.label >= 0 && (c.amount >= 0 || (c.debit >= 0 && c.credit >= 0))) {
      headerIdx = i;
      col = c;
      break;
    }
  }
  if (headerIdx < 0) {
    throw new Error("Colonnes non reconnues. Le fichier doit contenir : Date, Libellé, et Montant (ou Débit et Crédit).");
  }

  const out: ParsedLine[] = [];
  for (const r of rows.slice(headerIdx + 1) as unknown[][]) {
    const date = parseDate(r[col.date]);
    const label = String(r[col.label] ?? "").replace(/\s+/g, " ").trim();
    let amount: number | null;
    if (col.amount >= 0 && String(r[col.amount]).trim() !== "") amount = parseAmount(r[col.amount]);
    else {
      const d = parseAmount(r[col.debit]) ?? 0;
      const c = parseAmount(r[col.credit]) ?? 0;
      amount = c - Math.abs(d);
    }
    if (!date || !label || amount === null || amount === 0) continue;
    out.push({ date, label, amount });
  }
  if (!out.length) throw new Error("Aucune opération trouvée dans le fichier.");
  return out;
}
