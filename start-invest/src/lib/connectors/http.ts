export async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new Error(`Accès refusé (${res.status}) : vérifiez les identifiants. ${body}`);
    throw new Error(`Erreur ${res.status} sur ${new URL(url).host} : ${body}`);
  }
  return (await res.json()) as T;
}
