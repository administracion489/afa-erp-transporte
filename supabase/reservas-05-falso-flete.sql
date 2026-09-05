-- ────────────────────────────────────────────────────────────────────────────
-- reservas-05-falso-flete.sql — Una cancelación vale S/ 0.00 salvo que alguien
-- diga lo contrario, con nombre y motivo.
--
-- EL PROBLEMA QUE RESUELVE
--
-- Un servicio CANCELADO no se cobra ni se paga: el bus no salió. Pero el ERP no
-- tenía forma de saberlo, porque el importe se quedaba escrito en la reserva y
-- nada distinguía "este monto es un acuerdo" de "este monto sobró". De ahí
-- salían dos daños que parecen opuestos y son el mismo:
--
--   1) EL CIERRE PEDÍA UN COSTO QUE NADIE DEBE. `bloqueosDe` marcaba
--      "Sin costo de proveedor" sobre días enteros cancelados y los mandaba al
--      botón "Cargar N costo(s) faltante(s)". Seis servicios cancelados de la
--      RUTA B se leían como seis pendientes de trabajo que no existían. Peor:
--      el mensaje invitaba a cargarle un costo a un viaje que no ocurrió.
--
--   2) EL COSTO HUÉRFANO YA ESTABA PESANDO EN EL MARGEN. Los operadores dejan
--      la cancelada con el costo del proveedor puesto —error humano, todos los
--      meses— y `v_costo_servicio` / `v_egresos` leen `reservas.costo_proveedor`
--      sin preguntar si el servicio se prestó. El margen del mes ya salía peor
--      de lo que era, y nadie lo veía.
--
-- POR QUÉ UNA MARCA EXPLÍCITA Y NO "SI TIENE IMPORTE, SE PAGA"
--
-- El falso flete existe de verdad: cuando el proveedor ya salió de cochera o ya
-- llegó al punto de origen, AFA le reconoce el avance por acuerdo previo. La
-- tentación era deducirlo (cancelado + importe > 0 = falso flete) y avisar en
-- ámbar. Es la decisión equivocada, y la razón es de negocio, no de código:
--
--     Pagar de MENOS  → el proveedor reclama y se le paga después.  SE ARREGLA.
--     Pagar de MÁS    → hay que pedirle que devuelva.               NO VUELVE.
--
-- El default tiene que caer del lado del error reversible. Y como el importe
-- huérfano es JUSTO el que deja el error humano, deducir el falso flete del
-- importe habría convertido cada descuido en un pago. Un aviso ámbar no salva
-- eso: sale todos los meses, se vuelve paisaje, y el mes que importaba se firma
-- igual.
--
-- Por eso el importe NO autoriza nada por sí solo. Solo paga lo que lleva
-- `falso_flete = true`, que es un dato que alguien escribió DESPUÉS de saber que
-- el servicio se canceló.
--
-- LO QUE AGREGA ESTE ARCHIVO
--
--   reservas.falso_flete         — el acuerdo existe (solo lado PROVEEDOR)
--   reservas.falso_flete_motivo  — por qué se le paga un viaje que no salió
--   liquidacion_*_linea.tipo     — acepta 'falso_flete' (su propio subtotal)
--   v_falsos_fletes              — la vista para medirlos
--
-- AL CLIENTE NO SE LE COBRA NUNCA. Es una decisión comercial de AFA (fidelidad),
-- así que del lado cliente una cancelación vale 0 y no hay marca que lo cambie:
-- ofrecer la casilla sería ofrecer algo que la empresa decidió no hacer.
--
-- DEPENDENCIAS: liquidaciones-v2.sql (las tablas de línea). Es independiente de
-- reservas-04; el código tolera que cualquiera de las dos falte.
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 1) El acuerdo de falso flete
--
-- NOT NULL con DEFAULT false: en PostgreSQL 11+ no reescribe la tabla, y el
-- default es la razón de ser de esta migración — TODO lo cancelado que ya existe
-- pasa a valer S/ 0.00 sin que nadie tenga que revisarlo uno por uno. Los 218
-- "costos faltantes" de un proveedor real se resuelven solos, y del lado seguro.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists falso_flete boolean not null default false;

alter table public.reservas
  add column if not exists falso_flete_motivo text;

comment on column public.reservas.falso_flete is
  'Hay un acuerdo para pagarle al PROVEEDOR un servicio que se canceló (ya salió de '
  'cochera, ya llegó al punto de origen). Solo con esta marca en true el cierre paga el '
  'importe de una reserva cancelada; sin ella vale S/ 0.00 por más que costo_proveedor '
  'tenga un número, porque ese número suele ser el que dejó un error humano. NO aplica al '
  'lado cliente: a los clientes no se les cobra la cancelación.';

comment on column public.reservas.falso_flete_motivo is
  'Por qué se le paga al proveedor un viaje que no se prestó. Obligatorio al marcar '
  'falso_flete: es el ÚNICO sitio donde queda escrito el porqué de esa salida de dinero, '
  'igual que adicional_motivo lo es para el adicional.';

-- Nadie más que el cierre del proveedor lee esta marca, y solo sobre cancelados:
-- el índice parcial es diminuto y sirve para auditarlos ("¿qué falsos fletes
-- pagamos este año?").
create index if not exists idx_reservas_falso_flete
  on public.reservas (fecha_servicio desc)
  where falso_flete;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) El tipo de línea del formato
--
-- El falso flete NO puede sumar como 'servicio': el documento imprime la
-- CANTIDAD de servicios y diría 26 donde 25 salieron y 1 no — el mismo defecto
-- que el adicional ya corrigió. Tampoco como 'adicional': un adicional es algo
-- que el cliente pidió DE MÁS, y esto es lo contrario, algo que no se prestó.
--
-- Y no se puede reciclar 'penalidad' ni 'descuento': `totalesValorizacion` RESTA
-- todo lo que no sea servicio o adicional, así que un falso flete metido ahí
-- saldría en negativo.
--
-- Los dos CHECK se recrean (no se puede ampliar uno in situ). Sobre las tablas
-- de línea esto es barato: son miles de filas, no millones como `reservas`.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.liquidacion_cliente_linea') is not null then
    alter table public.liquidacion_cliente_linea
      drop constraint if exists liquidacion_cliente_linea_tipo_check;
    alter table public.liquidacion_cliente_linea
      add constraint liquidacion_cliente_linea_tipo_check
      check (tipo in ('servicio','adicional','falso_flete','penalidad','descuento'));
  end if;

  if to_regclass('public.liquidacion_proveedor_linea') is not null then
    alter table public.liquidacion_proveedor_linea
      drop constraint if exists liquidacion_proveedor_linea_tipo_check;
    alter table public.liquidacion_proveedor_linea
      add constraint liquidacion_proveedor_linea_tipo_check
      check (tipo in ('servicio','adicional','falso_flete','penalidad','descuento'));
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3) La vista para medirlos
--
-- No agrega ninguna regla: publica el hecho con su contexto para que los cortes
-- los haga quien consulta, igual que v_adicionales. Sirve para las dos preguntas
-- que hoy no se pueden contestar: "¿cuánto pagamos por servicios que no
-- salieron?" y "¿qué proveedor los concentra?".
-- ────────────────────────────────────────────────────────────────────────────
create or replace view public.v_falsos_fletes as
  select r.id,
         r.codigo,
         r.fecha_servicio,
         r.hora_servicio,
         r.estado,
         r.cliente_id,
         r.empresa_tercerizada_id,
         r.ruta_nombre,
         r.direccion_servicio,
         r.costo_proveedor,
         r.falso_flete_motivo,
         r.liquidacion_proveedor_id,
         r.estado_proveedor
    from public.reservas r
   where r.falso_flete;

comment on view public.v_falsos_fletes is
  'Servicios cancelados que sí se le pagan al proveedor por acuerdo de avance. Un falso '
  'flete con estado distinto de cancelada es una incoherencia que conviene revisar: la '
  'marca se pone sobre una cancelación, y si el servicio volvió a otro estado la marca '
  'quedó colgada.';

-- ────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano después de aplicar)
--
--   -- 1. Las columnas existen:
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name = 'reservas' and column_name like 'falso_flete%';
--
--   -- 2. Cuánto dinero deja de pagarse por estar en canceladas sin acuerdo
--   --    (esto es lo que hoy se paga o contamina el margen):
--   select count(*) as servicios,
--          sum(coalesce(costo_proveedor, 0)) as costo_huerfano,
--          sum(coalesce(precio_cliente, 0))  as precio_huerfano
--     from public.reservas
--    where estado = 'cancelada' and not falso_flete
--      and (coalesce(costo_proveedor,0) > 0 or coalesce(precio_cliente,0) > 0);
--
--   -- 3. El CHECK acepta el tipo nuevo:
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conname like 'liquidacion_%_linea_tipo_check';
--
-- Lo mismo, sin SQL y sobre los datos reales:
--   npx tsx scripts/diagnostico-cancelados.mts 2026-08-01 2026-08-31
-- ────────────────────────────────────────────────────────────────────────────
