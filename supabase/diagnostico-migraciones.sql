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

  -- ── LO DE ESTA SESIÓN ────────────────────────────────────────────────────────
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
