// Traduit les erreurs techniques (codes HTTP, JSON renvoyé par les banques ou les API) en une phrase claire.
// Appliqué à l'affichage : les anciennes erreurs déjà enregistrées sont donc aussi traduites.

export function humanError(raw: string | null | undefined): string {
  if (!raw) return "";
  const m = raw.toLowerCase();
  const bank = raw.match(/Banque ([^ ]+(?: [^ —]+)*?) indisponible/)?.[1];
  if (/\b408\b|timeout|timed out|etimedout|aspsp_timeout/.test(m))
    return `La banque${bank ? ` ${bank}` : ""} n'a pas répondu à temps : elle limite les accès automatiques (4 par jour et par compte). Rien à faire de votre côté, nouvel essai automatique dans quelques heures.`;
  if (/\b429\b|too many|rate limit/.test(m)) return "Trop de demandes envoyées : le service demande de patienter. Nouvel essai automatique plus tard, rien à faire.";
  if (/accord .*expir|consent.*expir|session.*expir|\b401\b|unauthorized|invalid_grant/.test(m))
    return "L'autorisation a expiré : reconnectez ce service (bouton « Connecter » sur la page Connexions).";
  if (/\b403\b|forbidden/.test(m)) return "Accès refusé par le service : vérifiez l'identifiant ou reconnectez ce service.";
  if (/abonnement shine facture/.test(m)) return "Shine Facture n'est pas activé sur votre compte Shine : sans cet abonnement, déposez les factures dans Archives (ou retirez cette connexion).";
  if (/authenticationfailed|invalid credentials|auth.*failed|login failed|mot de passe incorrect|application-specific password/.test(m))
    return "Identifiant ou mot de passe refusé. Pour Gmail, il faut un « mot de passe d'application » (16 lettres), pas le mot de passe habituel.";
  if (/introuvable après \d+ étapes|page de connexion|robot n'a pas/.test(m))
    return "Le robot ne trouve pas la bonne page sur ce logiciel. Cliquez « Se reconnecter » (page Connexions), allez vous-même jusqu'à la liste voulue, puis cliquez « Je suis connecté » : le robot repartira de cette page chaque jour.";
  if (/enotfound|getaddrinfo|econnrefused|econnreset|network|fetch failed/.test(m)) return "Service injoignable pour le moment (réseau). Nouvel essai automatique, rien à faire.";
  if (/\b50[0-4]\b|internal server error|bad gateway|service unavailable/.test(m)) return "Le service est en panne de son côté pour le moment. Nouvel essai automatique, rien à faire.";
  // Erreur déjà en français et sans JSON : on la garde, raccourcie.
  const clean = raw.replace(/\{[\s\S]*\}/g, "").replace(/\s+/g, " ").replace(/[—:-]\s*$/, "").trim();
  return clean.length > 220 ? clean.slice(0, 217) + "…" : clean || "Erreur inconnue : relancez la connexion.";
}

/** Faut-il une action du fondateur, ou le système réessaiera-t-il seul ? */
export function needsUserAction(raw: string | null | undefined) {
  const m = (raw ?? "").toLowerCase();
  if (/abonnement shine facture/.test(m)) return false; // facultatif : pas une urgence
  return !/\b408\b|timeout|timed out|\b429\b|too many|rate limit|\b50[0-4]\b|enotfound|econnrefused|econnreset|fetch failed|indisponible pour le moment/.test(m);
}
