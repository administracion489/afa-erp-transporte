# gps-analitica-01 · notas de la migración de excesos de velocidad

La migración son **tres archivos**, cada uno de menos de 100 líneas, y cada uno se pega **entero** en
Supabase → SQL Editor → Run. El deploy no los corre. Son idempotentes: se pueden volver a correr.

| Archivo | Qué crea | Cuándo |
|---|---|---|
| `gps-analitica-01a-puntos-rapidos.sql` | `fn_gps_puntos_rapidos` | a cualquier hora |
| `gps-analitica-01b-velocimetro.sql` | `fn_gps_velocimetro` | a cualquier hora |
| `gps-analitica-01c-indices.sql` | `idx_gps_rapidos` (+ los dos por conductor si faltan) | **hora valle** |

Antes y después: `supabase/diagnostico-gps-analitica-1-resumen.sql` (solo lee). Sus filas 6, 8 y 9
dicen si quedaron el índice y las dos funciones, y que ni `anon` ni `authenticated` las pueden ejecutar.

## Por qué tres archivos y no uno

Era un solo archivo de 545 líneas, y el 12-10-2026 llegó al editor **cortado en la línea 100** — el
mismo corte que ya había roto el diagnóstico. El visor del que se copia entrega las primeras 100
líneas. Con el código primero, el pegado cortado falló con «unterminated dollar-quoted string» y no
instaló nada (el lado seguro), pero tampoco había forma de correrlo. Cada archivo termina en
`-- FIN de <su nombre>`: si esa línea no está en el editor, se pegó cortado.

Cada archivo lleva sus propios `revoke`/`grant`: `create or replace function` le da EXECUTE a PUBLIC
y, en Supabase, a `anon` y `authenticated`. Si los permisos fueran en otro archivo, entre uno y otro
la función quedaría abierta a cualquiera. En el mismo archivo van en la misma transacción.

## Por qué `fn_gps_puntos_rapidos` no usa `SELECT … INTO`

Con `select …, … into v_recortado, v_puntos` el editor de Supabase mostraba «Potential issue
detected: This query creates a table without enabling Row Level Security… `v_recortado`». Es una
falsa alarma —dentro de una función plpgsql, `INTO` asigna variables, no crea tablas—, pero obliga a
elegir entre «Run without RLS» y «Run and enable RLS», y la segunda le agrega al script un
`alter table v_recortado …` sobre una tabla que no existe. La función ahora devuelve
`return (select jsonb_build_object(…))`, sin variables: mismo resultado, comprobado contra la versión
anterior en un PostgreSQL 16 local (umbrales 60/90/130, un día vacío y un día recortado al tope).
`count(*)` sin `group by` siempre devuelve una fila, así que `recortado` nunca sale nulo.

## Qué pasa si no se corren

Solo `/seguridad-vial` deja de medir: muestra un aviso ámbar que nombra el archivo que falta (el
lector detecta la función ausente con `funcionQueFalta`, lib/columna-faltante.ts, y NO cae a recorrer
la tabla entera). La estadística por servicio de `/uso-flota → Servicios` cuenta los excesos de cada
servicio leyendo su traza por `reserva_id`, igual que la torre, y no necesita esta migración.

- Sin **01a**: `/seguridad-vial` no mide nada (y no afirma «0 excesos»).
- Sin **01b**: mide, pero todos los conductores salen «no se sabe» en el velocímetro, con aviso.
- Sin **01c**: mide igual, leyendo la tabla GPS entera en cada día pedido — lento y compitiendo con la torre.

## Seguridad

Las dos funciones devuelven posiciones de **toda** la flota: solo las ejecuta el servidor
(service-role, detrás de `verificarUsuarioApi("monitoreo")` en `/api/flota/excesos`). Se revoca a
`public`, `anon` y `authenticated` y se concede solo a `service_role`.

Son **SECURITY INVOKER** a propósito, no definer: service-role no mira RLS, así que no les hace
falta. Y la sección 4 de `seguridad-01-rls.sql` le vuelve a dar EXECUTE a `authenticated` a TODA
función SECURITY DEFINER de `public` cada vez que se corre: una definer quedaría abierta a cualquier
usuario del ERP la próxima vez que alguien corra ese archivo. Las invoker no las toca. Sin SQL
dinámico: todos los parámetros van como parámetros, nunca concatenados.

## 01a · `fn_gps_puntos_rapidos`

Lo consume `lib/flota/excesos-datos.ts` → `puntosDeRpc` (lib/flota/excesos.ts).

```
fn_gps_puntos_rapidos(p_desde timestamptz, p_hasta timestamptz, p_umbral integer) → jsonb

{"recortado": bool,
 "puntos": [[epoch_ms, lat, lng, velocidad, precision_m, reserva_id, conductor_id,
             conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, simulado], …]}
```

- Filas de `ubicaciones_gps` con velocidad ≥ `p_umbral` y `created_at` en `[p_desde, p_hasta)`, en
  orden `(created_at, id)`. `created_at` es la hora del TELÉFONO, la misma con que se mide todo lo
  demás del rastreo (lib/gps-cobertura-datos.ts).
- `epoch_ms` = `created_at` en milisegundos (truncado), entero.
- `lat`, `lng`, `velocidad` (km/h) y `precision_m` (m) van con su tipo numérico; `precision_m` nula
  sale null (= precisión desconocida: el motor NO la toma por buena).
- Los cinco ids van como entero (cast a bigint) o null. El conductor vive en DOS columnas porque los
  ids de `conductores` y `conductores_tercero` se solapan: va llena una de las dos.
- `simulado`: true / false / null, tri-estado como la columna. Sin la columna, null en todos.
- **Tope de 60 000 puntos**: si había más, salen los 60 000 primeros y `"recortado": true`. La
  pantalla dice que ese día está incompleto, nunca lo cuenta como entero.
- Las filas con lat/lng nulos NO se filtran aquí: el motor las descarta.
- Un solo valor jsonb porque PostgREST corta toda respuesta tabular en 1000 filas, y un día de
  carretera tiene decenas de miles de puntos rápidos.

**Validaciones** (`raise exception`, SQLSTATE 22023 → PostgREST 400; el lector lo trata como error,
nunca como «0 puntos»): umbral entre 60 y 130 (60 es ESTRUCTURAL: el piso del índice parcial; 130 es
`VMAX_BUS_KMH` de lib/huella.ts), `p_hasta > p_desde` y como mucho 26 h (un día de Lima más el
colchón de ±60 s con que el lector une las tandas).

**El literal `velocidad >= 60` no sobra.** El umbral llega como parámetro, y con un plan genérico
(plpgsql lo usa a partir de la sexta llamada en la misma conexión) el planificador no puede demostrar
que `velocidad >= $3` implica el predicado del índice. Con el literal, la implicación es trivial y el
índice se usa siempre. Si cambias el piso, cámbialo en 01a, en 01c y en `UMBRAL_MIN_KMH` de
lib/flota/excesos.ts (`scripts/prueba-excesos.mts` lo comprueba).

**`simulado` se lee con `to_jsonb(g)`** porque la columna es de otra migración accesoria
(`ubicaciones-gps-simulado.sql`): nombrarla haría fallar la función en una base sin ella, y generar el
cuerpo según exista al correr esto lo congelaría (si la columna se agrega después, el veto de los
puntos simulados quedaría apagado en silencio). Cuesta ~4 µs por fila convertida (medido en PG 16):
~0.25 s en el peor caso del tope.

## 01b · `fn_gps_velocimetro`

```
fn_gps_velocimetro(p_desde timestamptz, p_hasta timestamptz, p_propios bigint[], p_terceros bigint[])
  → table(tabla text, conductor_id bigint, hay_puntos boolean, hay_velocidad boolean)
```

- Una fila por id DISTINTO y no nulo de cada arreglo (un arreglo nulo vale vacío):
  `tabla = 'conductores'` para `p_propios` y `'conductores_tercero'` para `p_terceros`. La clave del
  conductor es `(tabla, conductor_id)`: los ids de las dos tablas se solapan.
- `hay_puntos` = mandó al menos un punto en el rango. `hay_velocidad` = alguno trae velocidad > 0;
  **NULL cuando no hay puntos**: sin puntos no hay evidencia, y un false diría «su teléfono no tiene
  velocímetro», que no se midió. El lector lo lee con `velocimetroDe`.
- Cada respuesta es un `exists` sobre los índices por conductor: se corta en el primer punto que la
  contesta. El caso caro (un conductor sin ninguna velocidad) recorre sus puntos del rango, y por eso
  hay topes: como mucho 8 días y 300 ids por arreglo (22023 si no).

## 01c · los índices, y EL CANDADO

Un `CREATE INDEX` normal toma un lock SHARE sobre `ubicaciones_gps` que **bloquea los INSERT de GPS**
de toda la flota mientras construye (segundos con la tabla de hoy; para construir un índice parcial
igual hay que leer la tabla entera). No se pierde rastreo —la app del conductor encola los puntos y
los manda al reconectar—, pero va en **hora valle**, sin servicios en curso.

- `set lock_timeout = '5s'`: si la tabla está ocupada, falla en 5 s («canceling statement due to lock
  timeout») en vez de dejar los GPS encolados detrás. Se revierte entero; se reintenta en un minuto.
- Cada índice se crea **solo si falta**, y la comprobación va antes: `create index if not exists` toma
  el candado aunque el índice ya exista.
- `idx_gps_conductor_fecha` / `idx_gps_conductor_ter_fecha` son copias exactas de `retrasos.sql`
  (sección 7), por si se corre en una base sin ese módulo.
- **Por qué no va `concurrently`**: el SQL Editor envuelve todo el script en una transacción y
  `CREATE INDEX CONCURRENTLY` no puede correr dentro de una (ERROR 25001).

**Sin bloqueo, por psql** (Supabase → Connect → Connection string), donde cada sentencia va en
autocommit:

```sql
create index concurrently if not exists idx_gps_rapidos
  on public.ubicaciones_gps (created_at) where velocidad >= 60;
create index concurrently if not exists idx_gps_conductor_fecha
  on public.ubicaciones_gps (conductor_id, created_at desc) where conductor_id is not null;
create index concurrently if not exists idx_gps_conductor_ter_fecha
  on public.ubicaciones_gps (conductor_tercero_id, created_at desc) where conductor_tercero_id is not null;
```

Si un CONCURRENTLY falla a mitad, deja el índice **INVÁLIDO** con ese nombre (el planificador no lo
usa, pero se mantiene en cada INSERT). 01c lo avisa con un WARNING y no lo toca: borrarlo exige un
candado que bloquea también las lecturas. Se arregla por psql:

```sql
drop index concurrently if exists public.idx_gps_rapidos;   -- y volver a crearlo
```

## Revisión (después de correrlo)

Lo rápido es `diagnostico-gps-analitica-1-resumen.sql`. A mano, de a una:

```sql
-- 1) Las funciones: es_definer false, config {search_path=public}, anon false, erp false, servidor true.
select p.proname,
       p.provolatile = 's' as es_stable, p.prosecdef as es_definer, p.proconfig as config,
       has_function_privilege('anon',          p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as erp,
       has_function_privilege('service_role',  p.oid, 'execute') as servidor
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('fn_gps_puntos_rapidos', 'fn_gps_velocimetro');

-- 2) Los índices y si son VÁLIDOS.
select c.relname as indice, i.indisvalid as valido,
       pg_size_pretty(pg_relation_size(i.indexrelid)) as tamano, pg_get_indexdef(i.indexrelid) as definicion
  from pg_index i join pg_class c on c.oid = i.indexrelid
 where i.indrelid = 'public.ubicaciones_gps'::regclass
 order by 1;

-- 3) El plan (EXPLAIN sin ANALYZE no ejecuta). Esperado: Index Scan using idx_gps_rapidos.
--    Si sale «Seq Scan on ubicaciones_gps», el índice no está o no es válido.
explain
select g.created_at, row_number() over (order by g.created_at, g.id)
  from public.ubicaciones_gps g
 where g.velocidad >= 60 and g.velocidad >= 90
   and g.created_at >= now() - interval '1 day' and g.created_at < now()
 order by g.created_at, g.id
 limit 60001;

-- 4) Una llamada de verdad: ayer en Lima, umbral 90.
with d as (
  select ((date_trunc('day', now() at time zone 'America/Lima') - interval '1 day')
            at time zone 'America/Lima') as desde,
         (date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima') as hasta
)
select jsonb_array_length(j -> 'puntos') as puntos, j -> 'recortado' as recortado, j -> 'puntos' -> 0 as primero
  from (select public.fn_gps_puntos_rapidos(d.desde, d.hasta, 90) as j from d) r;

-- 5) Cada una debe FALLAR con 22023.
select public.fn_gps_puntos_rapidos(now(), now() - interval '1 hour', 90);   -- hasta <= desde
select public.fn_gps_puntos_rapidos(now() - interval '2 days', now(), 90);   -- > 26 h
select public.fn_gps_puntos_rapidos(now() - interval '1 day', now(), 50);    -- umbral < 60
select * from public.fn_gps_velocimetro(now() - interval '9 days', now(), null, null);  -- > 8 días
```

El SQL Editor corre como `postgres`, dueño de las funciones: las puede llamar aunque `anon` y
`authenticated` no.
