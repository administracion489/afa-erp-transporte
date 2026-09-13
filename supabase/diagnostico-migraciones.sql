-- supabase/diagnostico-migraciones.sql
-- ═══════════════════════════════════════════════════════════════════════════════
-- ¿QUÉ MIGRACIONES ESTÁN CORRIDAS Y CUÁLES NO?
--
-- SOLO LEE. No crea, no altera y no borra nada: se puede correr en producción a cualquier
-- hora y las veces que haga falta.
--
-- Este ERP no lleva tabla de control de migraciones (`supabase/` es una carpeta de scripts
-- que alguien ejecuta a mano), así que la única forma de saber qué está aplicado es
-- PREGUNTARLE AL CATÁLOGO DE POSTGRES si existe la tabla, la columna o la función que cada
-- script crea. Eso es lo que hace esto: por cada módulo mira su HUELLA y responde.
--
-- Nació de un error real: `documentos-tive-y-nombres.sql` falló con
-- `42P01 relation "public.documentos_tercero_revisiones" does not exist` porque el módulo de
-- autoservicio de proveedores nunca se había corrido — y no había forma de saberlo de
-- antemano salvo estrellarse.
--
-- CÓMO SE ELIGIÓ CADA HUELLA: es un objeto que crea ESE script y no otro, verificado uno por
-- uno contra los archivos del repo. Donde un script solo AMPLÍA una tabla que ya existía (las
-- fases 07 y 08 de finanzas, por ejemplo), la huella es una COLUMNA suya, no la tabla — si no,
-- daría por instalada una fase que no corrió.
--
-- Uso: Supabase → SQL Editor → pegar → Run. Sale una fila por módulo, lo que FALTA primero.
-- ═══════════════════════════════════════════════════════════════════════════════

with huella(orden, modulo, script, objeto, tipo, para_que) as (values
  -- ── NÚCLEO · si algo de esto falta, no es que falte un módulo: falta la base ──
  (1, 'Reservas · núcleo',             '(base)',                                      'reservas',                          'tabla',   'Los servicios. Es el corazón del ERP.'),
  (1, 'Flota propia',                  '(base)',                                      'vehiculos',                         'tabla',   'Unidades propias.'),
  (1, 'Documentos de unidad propia',   '(base)',                                      'documentos_vehiculo',               'tabla',   'SOAT, CITV, TUC… de la flota propia.'),
  (1, 'Tercerizadas',                  '(base)',                                      'empresas_tercerizadas',             'tabla',   'Proveedores, su flota y sus conductores.'),
  (1, 'Documentos de tercerizadas',    '(base)',                                      'documentos_tercero',                'tabla',   'Los papeles de las unidades del proveedor.'),

  -- ── LO MÁS RECIENTE ──────────────────────────────────────────────────────────
  (2, 'Empresa · autorización',        'empresa-01-autorizacion-transporte.sql',      'empresa_perfil.autorizacion_mtc',   'columna', 'Que el pie de la orden de trabajo imprima TU autorización de transporte. Sin esto no se puede guardar; el papel sale sin esa línea.'),
  (2, 'OT · costo al libro y factura', 'mantenimiento-05-costo-factura-cxp.sql',      'ordenes_trabajo.mantenimiento_id',  'columna', 'Que corregir el costo DESPUÉS de cerrar una OT llegue al egreso y al S/km medido, y que la factura del taller entre como CxP. Sin esto el costo se congela al cerrar.'),
  (2, 'OT · líneas de costo',          'mantenimiento-06-lineas-de-costo.sql',        'ot_costo_linea',                    'tabla',   'Repuesto en un sitio y mano de obra en otro, cada uno con su proveedor y su factura; y las horas del mecánico propio, que cuentan para el costo por km y NO como egreso.'),
  (2, 'Taller · valorizar la hora',    'mantenimiento-06-lineas-de-costo.sql',        'v_taller_mano_obra',                'vista',   'Los insumos para calcular cuánto vale una hora del mecánico de casa. Sin esto, una línea «Propio» no se puede valorizar.'),
  (2, 'Mantenimiento · OT automática', 'mantenimiento-ot-automatica.sql',             'ordenes_trabajo.origen',            'columna', 'Que el cron abra sola una orden de trabajo al llegar al umbral. Sin esto, esa parte de la configuración no se guarda.'),
  (2, 'Autorización y ámbito',         'tercerizadas-autorizacion-ambito.sql',        'empresas_tercerizadas.autoridad_habilitante', 'columna', 'Quién autoriza a cada proveedor y hasta dónde puede circular. SIN ESTO no se puede guardar la autoridad.'),
  (2, 'Nombres TUC/TIVE (opcional)',   'documentos-tive-y-nombres.sql',               'fn_norm_tipo_doc',                  'función', 'Limpieza de nombres y de fechas inventadas en la tarjeta de propiedad. El ERP funciona igual sin ella.'),

  -- ── MÓDULOS QUE SE INSTALAN POR SEPARADO ─────────────────────────────────────
  (3, 'Autoservicio de proveedores',   'proveedor-documentos-autoservicio.sql',       'documentos_tercero_revisiones',     'tabla',   'Link público para que el proveedor suba documentos y un operador los apruebe.'),
  (3, 'Liquidaciones',                 'liquidaciones-v2.sql',                        'liquidacion_cliente',               'tabla',   'Cierre mensual: valorización al cliente y al proveedor.'),
  (3, 'Liquidación · ruta contratada', 'liquidaciones-03-ruta-contratada.sql',        'cliente_ruta',                      'tabla',   'Ficha de la ruta y PAX contratado del AFA-FL-07.'),
  (3, 'Reservas · pax contratado',     'liquidaciones-03-ruta-contratada.sql',        'reservas.capacidad_contratada',     'columna', 'Los asientos que pactó el cliente (distinto de la capacidad del bus).'),
  (3, 'Servicios adicionales',         'reservas-04-servicios-adicionales.sql',       'reservas.origen_contractual',       'columna', 'Distinguir lo pedido por encima del contrato en la liquidación.'),
  (3, 'Falso flete',                   'reservas-05-falso-flete.sql',                 'reservas.falso_flete',              'columna', 'Pagar un avance acordado por un servicio cancelado.'),
  (3, 'Pacto · acta de precios',       'pacto-02-acta.sql',                           'servicio_pacto',                    'tabla',   'Quién cambió un precio o un costo, cuándo y por qué.'),
  (3, 'Finanzas · fundación',          'finanzas-00-fundacion.sql',                   'cat_detraccion',                    'tabla',   'Catálogos tributarios. Todo el módulo de dinero cuelga de aquí.'),
  (3, 'Finanzas · tesorería',          'finanzas-01-tesoreria-pagos.sql',             'pagos',                             'tabla',   'Pagos y su aplicación a comprobantes.'),
  (3, 'Finanzas · compras y CxP',      'finanzas-02-compras-cxp.sql',                 'documentos_compra',                 'tabla',   'Cuentas por pagar: el comprobante es la fuente del monto.'),
  (3, 'Finanzas · caja chica',         'finanzas-06-gastos-caja-chica.sql',           'caja_chica_fondos',                 'tabla',   'Fondos, rendiciones y gastos con comprobante.'),
  (3, 'Finanzas · detracciones (07)',  'finanzas-07-detracciones-catalogo.sql',       'cat_detraccion.base_legal',         'columna', 'Catálogo 54 completo y editable. OJO: también corrige los códigos 026/027, que la fase 00 sembró invertidos.'),
  (3, 'Finanzas · caja chica todos (08)','finanzas-08-caja-chica-todo-el-personal.sql','caja_chica_fondos.responsable_tipo','columna', 'Caja chica también para oficina, no solo conductores.'),
  (3, 'Costeo · planilla y presupuesto','costeo-01-planilla-y-presupuesto.sql',        'servicio_costo_estimado',           'tabla',   'Presupuesto por servicio y costo empresa del conductor.'),
  (3, 'Costeo · identidad del tipo',   'costos-01-identidad-tipo-vehiculo.sql',       'uq_parametros_costos_tipo',         'índice',  'Que `parametros_costos.tipo_vehiculo` identifique a UNA fila. Sin esto, dos tipos con la misma clave se editan a la vez y se leen al azar. La pantalla protege igual sin la migración, comprobándolo en cada guardado.'),
  (3, 'Puente placa → tipo de costeo', 'vehiculos-tipo-costeo.sql',                   'vehiculos.tipo_vehiculo_costeo',    'columna', 'Vincular cada unidad real con su ficha de costos. Sin esto, una cotización hecha con esa unidad no entra como referencia en /tarifario.'),
  (3, 'Contabilidad · asientos',       'contabilidad-04-plan-asientos.sql',           'asiento',                           'tabla',   'Plan de cuentas y asientos contables.'),
  (3, 'Mantenimiento y odómetro',      'mantenimiento-preventivo.sql',                'lecturas_odometro',                 'tabla',   'Planes del fabricante, órdenes de trabajo y kilometraje.'),
  (3, 'Odómetro de terceros',          'odometro-terceros.sql',                       'lecturas_odometro.vehiculo_tercero_id','columna','Leer el tablero también de las unidades del proveedor.'),
  (3, 'Radar IA',                      'radar-ia.sql',                                'radar_mensajes',                    'tabla',   'Grupos de WhatsApp → ERP.'),
  (3, 'Radar · vigencia de grupos',    'radar-ia-grupos-vigencia.sql',                'radar_grupos.visible',              'columna', 'Tachar los grupos que el número conectado ya no ve.'),
  (3, 'CRM',                           'crm-schema.sql',                              'crm_conversaciones',                'tabla',   'Inbox, pipeline y agente comercial.'),
  (3, 'Órdenes de compra',             'ordenes-compra.sql',                          'ordenes_compra',                    'tabla',   'Lo que se le pide formalmente a un proveedor.'),
  (3, 'Push a conductores',            'push-notificaciones.sql',                     'push_suscripciones',                'tabla',   'Avisos al celular del conductor.'),
  (3, 'Comunicados',                   'comunicados.sql',                             'comunicados',                       'tabla',   'Mensajes masivos a pasajeros y conductores.')
),

-- Se resuelve UNA vez y se reutiliza para pintar y para ordenar. `to_regclass` no se usa:
-- con una huella de columna ("reservas.falso_flete") recibiría un nombre de tres partes y
-- Postgres lo lee como base_de_datos.esquema.tabla → "cross-database references are not
-- implemented". Con `information_schema` la comprobación es uniforme para los tres tipos.
estado as (
  select
    h.*,
    case h.tipo
      when 'tabla' then exists (
        select 1 from information_schema.tables
         where table_schema = 'public' and table_name = h.objeto)
      when 'columna' then exists (
        select 1 from information_schema.columns
         where table_schema = 'public'
           and table_name  = split_part(h.objeto, '.', 1)
           and column_name = split_part(h.objeto, '.', 2))
      when 'función' then exists (
        select 1 from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = h.objeto)
      -- Un índice no está en information_schema: se pregunta por su nombre en pg_indexes.
      -- Hace falta porque hay migraciones cuyo único artefacto es un índice (una RESTRICCIÓN,
      -- no una tabla nueva), y sin esta rama caían en el `else false` de abajo y salían
      -- "❌ FALTA" para siempre, aunque se hubieran corrido.
      when 'índice' then exists (
        select 1 from pg_indexes
         where schemaname = 'public' and indexname = h.objeto)
      -- Una vista sí está en information_schema, pero en `views`, no en `tables`. Se pregunta
      -- aparte para que la columna "se comprueba mirando" diga la verdad sobre qué es el objeto.
      when 'vista' then exists (
        select 1 from information_schema.views
         where table_schema = 'public' and table_name = h.objeto)
      else false
    end as instalado
  from huella h
)

select
  case when instalado then '✅ INSTALADO' else '❌ FALTA' end as estado,
  modulo,
  script  as "correr este archivo",
  para_que as "qué te da",
  objeto  as "se comprueba mirando"
from estado
order by instalado, orden, modulo;   -- lo que falta primero; false ordena antes que true

-- ── CÓMO ACTUAR SOBRE EL RESULTADO ─────────────────────────────────────────────
--
-- · ❌ en un módulo que NO usas → déjalo. Ninguna migración es obligatoria por sí misma; lo
--   que pasa es que esa pantalla no funciona, o funciona a medias y lo dice.
--
-- · ❌ en un módulo que SÍ usas → corre su script. Están todos en `supabase/`.
--
-- · ❌ en algo marcado (base) → eso sí es raro: significa que falta una tabla que el ERP da
--   por sentada. Antes de tocar nada, pregunta.
--
-- · ESTA LISTA NO ES EXHAUSTIVA, y conviene tenerlo claro: comprueba UNA huella por módulo,
--   no cada columna que cada script agrega. Un ✅ dice "el script principal corrió", no
--   "estás al día con todos sus parches". Para lo accesorio el ERP degrada solo y lo avisa en
--   pantalla (patrón `COLUMNAS_OPCIONALES` de lib/reservas-pacto.ts).
--
-- · Si un script falla a mitad: el editor SQL de Supabase envuelve el bloque en una
--   transacción, así que o entra todo o no entra nada. Arregla la causa y vuelve a correrlo
--   entero — los scripts del repo son idempotentes salvo aviso en contrario.


-- ═══════════════════════════════════════════════════════════════════════════════
-- BLOQUE 2 · LAS MIGRACIONES QUE NO CREAN NADA, SOLO MUEVEN DATOS
--
-- CÓRRELO APARTE, DESPUÉS DEL DE ARRIBA. Es otra consulta: selecciona desde aquí hasta el final
-- y dale Run. También SOLO LEE.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ HACE FALTA UN SEGUNDO BLOQUE, Y POR QUÉ NO PUEDE DECIR «INSTALADO»
--
-- El bloque de arriba le pregunta al catálogo de Postgres si existe una tabla o una columna. Eso
-- funciona con una migración que crea algo — pero `costos-02`, `costos-03`, `costos-04`,
-- `costos-05` y `pacto-06` **no crean nada**: hacen INSERT y UPDATE sobre filas que ya existían.
-- Para ellas el catálogo se ve idéntico antes y después, así que no hay huella que buscar.
--
-- Lo único que se puede hacer es mirar QUÉ DICEN LOS DATOS HOY, y eso no es lo mismo que saber
-- si el script corrió: alguien pudo editar esa ficha a mano cinco minutos después y dejarla como
-- estaba. Por eso estas filas responden **«la base dice esto»** y no «✅ instalado». La lectura
-- correcta es al revés: si el resultado ya es el que querías, da igual quién lo puso.
--
-- SI ALGUNA CONSULTA FALLA con `relation "..." does not exist`, esa es la respuesta: ese módulo
-- no está instalado y su migración de datos no pudo correr.
-- ═══════════════════════════════════════════════════════════════════════════════

with
-- Las fichas de costeo, emparejadas: cada Estándar con su gemela Full Equipo por la CLAVE
-- (`<CLAVE>_ESTANDAR`), nunca por el nombre — el nombre es texto editable desde el modal.
pares as (
  select p.tipo_vehiculo                as clave_full,
         p.nombre                       as nombre_full,
         p.mantenimiento_km             as mant_full,
         p.vida_util_anios              as vida_full,
         e.tipo_vehiculo                as clave_est,
         e.nombre                       as nombre_est,
         e.mantenimiento_km             as mant_est,
         e.vida_util_anios              as vida_est
    from public.parametros_costos p
    join public.parametros_costos e on e.tipo_vehiculo = p.tipo_vehiculo || '_ESTANDAR'
   where p.activo = true and e.activo = true
),
hechos(orden, verificacion, script, resultado, que_significa) as (

  -- ── costos-02 · ¿existen las fichas de unidad usada? ──────────────────────────
  select 1,
         'Fichas de unidad usada (clave `_ESTANDAR`)',
         'costos-02-categorias-estandar-usado.sql',
         (select count(*)::text || ' ficha(s) Estándar activas, emparejadas con su gemela'
            from pares),
         'Si sale 0, `costos-02` no corrió: el cotizador solo ofrece unidades Full Equipo.'

  -- ── costos-05 · ¿queda la palabra «Premium» en algún nombre? ──────────────────
  union all
  select 2,
         'La palabra comercial en el nombre de la ficha',
         'costos-05-nombres-full-equipo.sql',
         (select (count(*) filter (where nombre ilike '%premium%'))::text || ' con «Premium» · ' ||
                 (count(*) filter (where nombre like '%Full Equipo%'))::text || ' con «Full Equipo»'
            from public.parametros_costos where activo = true),
         'Con «Premium» en 0 y «Full Equipo» > 0, `costos-05` corrió. Si sigues leyendo «Premium» en el selector, falta.'

  -- ── costos-03 · ¿el nombre declara el criterio de antigüedad? ─────────────────
  union all
  select 3,
         'El paréntesis de antigüedad en el nombre',
         'costos-03-nombres-por-antiguedad.sql',
         (select count(*)::text || ' ficha(s) dicen «(>10 años)»'
            from public.parametros_costos
           where activo = true and nombre like '%(>10 años)%'),
         'Es el criterio con el que se decide a qué ficha va una placa. En 0 con fichas Estándar existentes, `costos-03` no corrió.'

  -- ── costos-04 · ¿la Estándar cuesta lo mismo de taller que su gemela? ─────────
  --    Es la DECISIÓN PROVISIONAL del dueño: igualar mantenimiento y vida útil hasta tener
  --    datos reales. Se mira el estado, no el sello, porque el sello lo pisa cualquier edición.
  union all
  select 4,
         'Mantenimiento y vida útil de la Estándar vs. su gemela',
         'costos-04-estandar-provisional.sql',
         (select (count(*) filter (where mant_est is not distinct from mant_full
                                     and vida_est is not distinct from vida_full))::text
                 || ' de ' || count(*)::text || ' par(es) igualados'
            from pares),
         'Igualados = la decisión provisional está puesta y la Estándar sale MÁS BARATA. Sin igualar, la Estándar cuesta más que la nueva y el cotizador lo enseña al revés de lo que esperas.'

  -- ── pacto-06 · ¿se sigue emitiendo el enlace de conformidad por cambio? ───────
  union all
  select 5,
         'Enlace de conformidad al cliente por cada cambio de precio',
         'pacto-06-sin-conformidad-de-cambio.sql',
         (select case when count(*) = 0 then 'sin política registrada'
                      when bool_or(coalesce(exige_conformidad_cliente, true)) then 'SIGUE EMITIENDO enlaces'
                      else 'apagado' end
            from public.pacto_politica),
         'Apagado es lo correcto: el cliente firma una vez al mes en la valorización. Si sigue emitiendo, se le pide la misma plata por dos puertas.'
)
select orden as "#",
       verificacion  as "qué se verifica",
       resultado     as "la base dice",
       script        as "script que lo produce",
       que_significa as "cómo se lee"
  from hechos
 order by orden;

-- ── Y EL ESTADO DE LAS ÓRDENES DE TRABAJO, que es donde vive el dinero del taller ───
-- Requiere `mantenimiento-05` y `mantenimiento-06`. Si falla, es que no están corridas.
select count(*)                                                        as ot_totales,
       count(*) filter (where estado = 'cerrada')                      as cerradas,
       count(*) filter (where estado = 'cerrada' and mantenimiento_id is null)
                                                                       as "cerradas SIN ancla al libro",
       count(*) filter (where coalesce(costo_total, 0) = 0 and estado = 'cerrada')
                                                                       as "cerradas sin costo tecleado",
       (select count(*) from public.ot_costo_linea)                    as lineas_de_costo,
       (select count(*) from public.ot_costo_linea where origen = 'propio')
                                                                       as "líneas de casa (no son egreso)",
       (select coalesce(sum(costo_imputado), 0) from public.mantenimiento)
                                                                       as "S/ imputado en el libro"
  from public.ordenes_trabajo;
-- Cómo se lee: «cerradas SIN ancla» debería ser 0 — esas no propagan su costo al egreso y se
-- arreglan a mano en /mantenimiento → Historial. «S/ imputado» estará en 0 hasta que exista un
-- mecánico propio con horas cargadas a alguna orden.
