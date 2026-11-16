import { redirect } from "next/navigation";

// Ancienne adresse : la liste « Tout connecter » est maintenant en haut de la page Connexions.
export default function ToutConnecterPage() {
  redirect("/connexions");
}
