export type FieldDef = { name: string; label: string; secret?: boolean; placeholder?: string; help?: string };

export type ProviderDef = {
  id: string;
  name: string;
  kind: "Banque" | "Paiements" | "Facturation" | "Agrégateur bancaire" | "Comptabilité";
  description: string;
  fields: FieldDef[];
  docs: string;
  available: boolean;
  /** Connexion par bouton « Se connecter avec ... » (OAuth) au lieu d'une clé API. */
  oauth?: boolean;
};

export type SyncResult = { accounts: number; transactions: number; invoices: number };
