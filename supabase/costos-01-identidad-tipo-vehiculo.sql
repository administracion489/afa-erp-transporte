-- costos-01-identidad-tipo-vehiculo.sql
-- `parametros_costos.tipo_vehiculo` es una IDENTIDAD. Esto la hace única de verdad.
--
-- QUÉ ARREGLA
--
-- Todo el ERP escribe y lee esa tabla por esa clave, y nada garantizaba que fuera única:
--
--   · app/configuracion/costos/page.tsx  →  update … where tipo_vehiculo = 'X'   (todas las filas)
--   · lib/costeo-servicio.ts             →  select … eq(tipo_vehiculo,'X').maybeSingle()
--
-- Con dos filas de la misma clave, una edición escribe en las dos y la lectura elige una al
-- azar — o revienta. Y llegar a ese estado es fácil: no hay DDL versionado de esta tabla en
-- el repo, el alta (`FormNuevoVeh`) no comprueba si la clave ya existe, y "Desactivar" no
-- borra la fila: solo pone `activo = false`, así que la clave sigue ocupada e invisible.
--
-- Es el mismo patrón que ya costó tres fallos en producción el mismo día con el PAX
-- contratado: escribir bajo una clave y leer bajo otra. Aquí la clave es la misma; lo que
-- falta es que identifique a UNA fila.
--
-- QUÉ NO HACE, Y POR QUÉ
--
-- · NO crea `parametros_costos`. La tabla existe desde antes de este repo. Si este script
--   falla diciendo que no existe, esa es otra conversación: no la crees a ciegas.
--
-- · NO le pone FK a `vehiculos.tipo_vehiculo_costeo` (ni a la de `vehiculos_tercero`), que
--   es el puente placa→tipo. Una FK obligaría a limpiar los huérfanos dentro de una
--   migración que tiene que poder correrse a ciegas, y haría fallar el alta de un bus por un
--   dato accesorio. El puente sigue siendo texto libre a propósito.
--
-- · NO borra ni fusiona nada. Si hay duplicados, este script se PARA y te dice cuáles son.
--   Cuál de las dos filas se queda es una decisión con dinero detrás —cada una tiene su
--   rendimiento, su valor de compra y su conductor/día— y no la toma una migración.
--
-- ES IDEMPOTENTE: correrlo dos veces no hace nada la segunda.
--
-- EL DEPLOY NO LO CORRE. Hay que ejecutarlo a mano en el editor SQL de Supabase.
-- Mientras no se corra, `escribirParametro` (lib/costos/parametros.ts) protege igual: mira
-- cuántas filas tiene la clave ANTES de escribir y se niega si hay más de una.

-- ── 1 · EL FRENO ───────────────────────────────────────────────────────────────
-- Se para ANTES de intentar el índice para que el mensaje diga qué hacer, en vez del
-- "could not create unique index … Key (tipo_vehiculo)=(BUS_45) is duplicated" de Postgres,
-- que nombra una clave y calla las demás.
do $$
declare
  duplicadas text;
begin
  select string_agg(format('%s (%s filas, %s activa(s))', tipo_vehiculo, n, n_act), '; ' order by tipo_vehiculo)
    into duplicadas
    from (
      select tipo_vehiculo,
             count(*)                            as n,
             count(*) filter (where activo)      as n_act
        from public.parametros_costos
       group by tipo_vehiculo
      having count(*) > 1
    ) d;

  if duplicadas is not null then
    raise exception
      E'No se creó el índice: hay claves de tipo de vehículo repetidas.\n'
      '  %\n'
      'Decide cuál fila se queda ANTES de volver a correr este script. Para verlas enteras:\n'
      '  select * from public.parametros_costos\n'
      '   where tipo_vehiculo in (select tipo_vehiculo from public.parametros_costos\n'
      '                            group by tipo_vehiculo having count(*) > 1)\n'
      '   order by tipo_vehiculo, id;\n'
      'La sobrante se BORRA (delete), no se desactiva: `activo = false` deja la clave ocupada,\n'
      'que es justo cómo se llega a esto.',
      duplicadas;
  end if;
end $$;

-- ── 2 · LA IDENTIDAD ───────────────────────────────────────────────────────────
-- Sin filtro parcial por `activo`: un tipo desactivado conserva su clave, y reusarla haría
-- que reactivarlo chocara con el que ocupó su sitio.
create unique index if not exists uq_parametros_costos_tipo
  on public.parametros_costos (tipo_vehiculo);

-- ── 3 · QUÉ SIGNIFICA LA COLUMNA QUE VIENE DETRÁS DE ESTO ──────────────────────
comment on column public.parametros_costos.rendimiento_1 is
  'Km por galón (o m³ en GNV) TECLEADOS para este tipo de vehículo. Es una premisa, no una '
  'medición: el rendimiento real de una placa se deriva de sus cargas en `combustible` '
  '(lib/rendimiento.ts) y el presupuesto de un servicio con placa asignada ya lo prefiere '
  '(lib/costeo-servicio.ts). Este número es el respaldo del TIPO, y es el que usan /cotizador, '
  '/cotizaciones y /tarifario cuando todavía no hay unidad elegida. Se cambia desde '
  '/configuracion/costos y cada cambio deja fila en `historial_costos`.';
