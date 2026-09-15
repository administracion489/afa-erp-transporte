-- supabase/combustible-01-tanque-lleno.sql
--
-- EL MÉTODO TANQUE LLENO A TANQUE LLENO, Y POR QUÉ HACE FALTA UNA COLUMNA.
--
-- El rendimiento se mide dividiendo los km de un tramo entre lo despachado al cerrarlo, y esa
-- cuenta SOLO es correcta si los dos extremos quedaron a tope: ahí el nivel restante —que nadie
-- mide— se cancela solo (se carga hasta L, se recorren X km, baja a un R desconocido, y al
-- recargar la bomba entrega G; lo consumido fue L − R, que es exactamente G). Con una carga
-- parcial en un extremo el denominador es menor que lo consumido y el rendimiento sale INFLADO.
--
-- Y ESE ERROR HOY ES INDISTINGUIBLE DE OTRO MÁS GRAVE. Una parcial no declarada produce el
-- mismo síntoma que una carga comprada y nunca registrada: `rendimiento_alto`, que este ERP
-- lee —con razón— como "plata que falta en los libros". Sin esta columna las dos causas se
-- mezclan en el mismo rojo, y solo una de las dos es un problema de dinero.
--
-- TRI-ESTADO, NO BOOLEANO CON DEFAULT. La política de AFA es cargar siempre a tope, pero:
--
--   · el FORMULARIO lo afirma (una persona marca la casilla)      → true / false
--   · el RADAR IA no lo puede saber: un voucher no dice si el
--     tanque quedó lleno                                          → null
--
-- Poner `default true` en la columna haría que cada carga que entra por WhatsApp AFIRMARA algo
-- que nadie observó, que es justo lo que este ERP se niega a hacer en todas partes (ver el
-- tri-estado del semáforo de puntualidad y el PAX contratado). Por eso la columna nace
-- NULLABLE y SIN DEFAULT, y el default vive en el FORMULARIO, que es donde hay alguien que lo
-- está afirmando.
--
-- Lo que hace el motor con cada estado (lib/rendimiento.ts), y SOLO UNO cambia algo:
--   true   → ANCLA: cierra una medición, y el tramo queda declarado como CONFIRMADO.
--   null   → ANCLA igual, por la política de la empresa (cargar siempre a tope). El tramo se
--            mide y declara `tanqueConfirmado: false`, para no esconder sobre qué se apoya.
--   false  → lo ÚNICO que no ancla: su combustible se ABSORBE y se suma al del próximo tanque
--            lleno, que es donde se mide. No se pierde.
--
-- NO HAY BACKFILL, y es deliberado: escribir `true` en el histórico afirmaría de miles de
-- cargas algo que nadie declaró.
--
-- POR ESO `null` TIENE QUE ANCLAR, y no es una concesión: sin backfill, el día que se corre
-- este SQL TODO el histórico pasa a `null` de golpe. Si `null` no anclara, ese día la flota
-- entera se quedaría sin un solo tramo medido — medianas en null, la columna «Medido» de
-- /configuracion/costos vacía y el presupuesto de cada servicio cayendo al parámetro tecleado.
-- O sea: correr un SQL accesorio apagaría el módulo. Anclar en `null` deja el comportamiento
-- EXACTAMENTE como está hoy (que es la premisa con la que ya se venía midiendo) y la única
-- diferencia la introduce una persona el día que marca que una carga NO llenó el tanque.
-- `scripts/prueba-rendimiento.mts` fija esa transición: correr la migración no mueve ni un
-- tramo medido ni una mediana.
--
-- Correr una vez en el editor SQL de Supabase. Todo IF NOT EXISTS / nullable → seguro de
-- correr antes o después del deploy del código. EL DEPLOY NO LA CORRE.

-- ── 1) ¿Quedó lleno el tanque? ───────────────────────────────────────────────
alter table public.combustible
  add column if not exists tanque_lleno boolean;

comment on column public.combustible.tanque_lleno is
  'TRI-ESTADO. true = el tanque quedó a tope (ancla del método tanque-lleno-a-tanque-lleno); '
  'false = carga parcial (sin crédito, sin stock en el grifo); null = nadie lo declaró. '
  'SIN DEFAULT a propósito: el Radar IA no puede saberlo desde un voucher.';

-- ── 2) De dónde salió esa afirmación ─────────────────────────────────────────
--
-- Un `true` que puso una persona mirando el surtidor y un `true` que salió de la política de
-- la empresa NO valen lo mismo, y un número construido sobre el segundo tiene que poder
-- decirlo. Es el mismo patrón de `CostoUnidad.fuentes` y de `resolverPaxDeServicio`: cada
-- dato declara su procedencia en vez de que la pantalla la adivine.
alter table public.combustible
  add column if not exists tanque_lleno_fuente text;

alter table public.combustible drop constraint if exists combustible_tanque_fuente_chk;
alter table public.combustible
  add constraint combustible_tanque_fuente_chk
  check (tanque_lleno_fuente is null or tanque_lleno_fuente in (
    'operador',   -- una persona marcó la casilla. La afirmación más fuerte.
    'conductor',  -- lo reportó quien cargó.
    'ia_aguja',   -- el Radar leyó el nivel en la foto del tablero. PROPUESTA, nunca decisión.
    'politica'    -- nadie lo dijo; se asume por la regla operativa de la empresa, y se DICE.
  ));

comment on column public.combustible.tanque_lleno_fuente is
  'Quién afirma `tanque_lleno`. Un true de la política no vale lo mismo que uno de una '
  'persona, y el rendimiento construido sobre él tiene que poder declararlo.';

-- ── 3) El motivo de un salto de km que no cabe en un tanque ──────────────────
--
-- Un delta de km mayor que lo que el tanque de esa unidad puede rendir significa casi siempre
-- una carga que se hizo y nadie registró. Guardarlo en silencio deja el hueco escondido; NO
-- guardarlo pierde la fila. La salida de este ERP para eso es siempre la misma —la de
-- `falso_flete_motivo` y `adicional_motivo`—: se guarda, pero con el motivo escrito, y el
-- motivo bloquea el guardado hasta que alguien lo teclea.
alter table public.combustible
  add column if not exists km_salto_motivo text;

comment on column public.combustible.km_salto_motivo is
  'Por qué el salto de kilometraje de esta carga supera lo que rinde un tanque de esta unidad. '
  'Lo teclea quien registra; el Radar no bloquea (manda la fila a revisión, que es su equivalente).';

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select tanque_lleno, tanque_lleno_fuente, count(*)
--   from public.combustible group by 1,2 order by 3 desc;
