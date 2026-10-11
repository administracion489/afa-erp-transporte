// Pruebas de lib/push-endpoint.ts: a qué direcciones le puede mandar el servidor una
// notificación web. Solo a los servicios push de los navegadores.
// Uso:  npx tsx scripts/prueba-push-endpoint.mts   (sale con código 1 si algo falla)

import { endpointPushValido } from "../lib/push-endpoint";

let fallos = 0;
const chk = (nombre: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}`);
  if (!ok) fallos++;
};

console.log("\n— Los servicios reales pasan —");
for (const u of [
  "https://fcm.googleapis.com/fcm/send/dXyz:APA91bH",
  "https://android.googleapis.com/gcm/send/abc",
  "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB",
  "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
  "https://web.push.apple.com/QGuQyavXutnMH",
  "https://FCM.googleapis.com/fcm/send/x",
]) chk(u, endpointPushValido(u));

console.log("\n— Lo demás no —");
for (const u of [
  "", "no es url", "http://fcm.googleapis.com/fcm/send/x",
  "https://evil.example.com/fcm.googleapis.com",
  "https://fcm.googleapis.com.evil.com/x",
  "https://notify.windows.com/x",                 // el sufijo solo, sin subdominio
  "https://evilnotify.windows.com.attacker.io/x",
  "https://user:pass@fcm.googleapis.com/x",
  "https://fcm.googleapis.com:8443/x",
  "https://169.254.169.254/latest/meta-data",
  "https://localhost/x",
  `https://fcm.googleapis.com/${"x".repeat(1100)}`,
]) chk(`rechaza «${u.slice(0, 60)}»`, !endpointPushValido(u));
chk("null/undefined", !endpointPushValido(null) && !endpointPushValido(undefined));

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
