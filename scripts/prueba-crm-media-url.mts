// npx tsx scripts/prueba-crm-media-url.mts
// El token de WhatsApp solo puede ir a Meta: host EXACTO o subdominio, https, sin credenciales
// ni puertos raros. Un regex sin anclar («contiene fbsbx.com») lo mandaba a cualquier sitio.
import { esUrlMediaMeta } from "../lib/crm-media";
let fallos = 0;
const caso = (url: string | null, esperado: boolean) => {
  const r = esUrlMediaMeta(url);
  if (r !== esperado) { fallos++; console.log("✗", url, "→", r, "esperado", esperado); }
  else console.log("✓", url, "→", r);
};
caso("https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123", true);
caso("https://fbsbx.com/x", true);
caso("https://mmg.whatsapp.net/v/t62/abc", true);
caso("https://atacante.tld/x?fbsbx.com", false);
caso("https://atacante.tld/?facebook.com", false);
caso("https://fbsbx.com.atacante.tld/", false);
caso("https://notfbsbx.com/", false);
caso("https://evilwhatsapp.net/", false);
caso("http://lookaside.fbsbx.com/x", false);
caso("https://user:pass@lookaside.fbsbx.com/x", false);
caso("https://lookaside.fbsbx.com:8443/x", false);
caso("https://www.facebook.com/x", false);
caso("javascript:alert(1)//fbsbx.com", false);
caso("no es una url fbsbx.com", false);
caso("", false);
caso(null, false);
console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo OK");
process.exit(fallos ? 1 : 0);
