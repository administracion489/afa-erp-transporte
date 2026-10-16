// Matriz: quién escribe por WhatsApp (teléfono, BSUID de un «usuario», o nada).
// npx tsx scripts/prueba-identidad-whatsapp.mts
import { identidadWhatsApp } from "../lib/crm-ingesta";

let fallos = 0;
const ok = (nombre: string, real: unknown, esperado: unknown) => {
  const bien = JSON.stringify(real) === JSON.stringify(esperado);
  if (!bien) fallos++;
  console.log(`${bien ? "✓" : "✗"} ${nombre}${bien ? "" : `  → ${JSON.stringify(real)} (esperado ${JSON.stringify(esperado)})`}`);
};

ok("número normal", identidadWhatsApp({ from: "51970106206" }, [{ wa_id: "51970106206" }]), { id: "51970106206", telefono: "51970106206" });
ok("usuario: BSUID en from", identidadWhatsApp({ from: "PE.1349120865530274" }, [{ user_id: "PE.1349120865530274" }]), { id: "PE.1349120865530274", telefono: null });
ok("usuario: sin from, from_user_id", identidadWhatsApp({ from_user_id: "PE.99" }, [{ profile: { name: "Charle" } }]), { id: "PE.99", telefono: null });
ok("usuario: sin from, solo contacts.user_id", identidadWhatsApp({}, [{ user_id: "PE.77", profile: { name: "Charle" } }]), { id: "PE.77", telefono: null });
ok("usuario que muestra su número: gana el teléfono", identidadWhatsApp({ from_user_id: "PE.5" }, [{ wa_id: "51999888777", user_id: "PE.5" }]), { id: "51999888777", telefono: "51999888777" });
ok("nada de nada", identidadWhatsApp({}, []), { id: null, telefono: null });
ok("mismo BSUID en tres mensajes = mismo id", [1, 2, 3].map(() => identidadWhatsApp({ from_user_id: "PE.42" }, [])).every((x) => x.id === "PE.42"), true);

console.log(fallos ? `\n✗ ${fallos} fallo(s)` : "\n✓ todo OK");
process.exit(fallos ? 1 : 0);
