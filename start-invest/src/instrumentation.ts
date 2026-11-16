export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Secours : RESET_2FA_FOR="email:jeton-unique" désactive UNE fois la double authentification de ce compte
  // (téléphone perdu) et lève le blocage des essais. Le jeton empêche toute répétition ; retirer ensuite la variable.
  const reset = process.env.RESET_2FA_FOR;
  if (reset) {
    try {
      const { prisma } = await import("./lib/prisma");
      const [email, nonce = ""] = reset.split(":");
      const key = `reset2fa:${email}:${nonce}`;
      if (email && nonce.length >= 8 && !(await prisma.appSetting.findUnique({ where: { key } }))) {
        const u = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
        if (u) {
          await prisma.user.update({ where: { id: u.id }, data: { totpEnabled: false, totpSecret: null } });
          await prisma.loginAttempt.deleteMany({ where: { success: false, createdAt: { gte: new Date(Date.now() - 86400000) } } });
          await prisma.auditLog.create({ data: { userEmail: u.email, action: "double_authentification_reinitialisee", detail: "secours serveur (RESET_2FA_FOR)" } }).catch(() => undefined);
          console.log(`[secours] double authentification réinitialisée pour ${u.email}`);
        }
        await prisma.appSetting.create({ data: { key, value: new Date().toISOString() } });
      }
    } catch (e) {
      console.error("[secours]", e);
    }
  }
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();
}
