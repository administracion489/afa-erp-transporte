# seguros-04 · coberturas múltiples e inclusiones pendientes

**Esta migración NO la corre el deploy: hay que ejecutarla en Supabase → SQL Editor**, en este orden y cada archivo entero con Run:

1. `seguros-04a-coberturas-e-inclusion.sql`
2. `seguros-04b-vista-persona.sql`

Requisito: `seguros-01`, `-02` y `-03` ya corridas. Los dos archivos son idempotentes.

## Qué hace cada archivo

**04a** (columnas y reglas, sin backfill):

- `seguros.coberturas text[]`: los tipos de persona que cubre una póliza (por ejemplo, un contrato que cubre SCTR salud, SCTR pensión y Vida Ley a la vez). `null` = solo cubre `tipo`, que es como se comporta hoy. La regla `ck_seguros_coberturas` exige entre 1 y 3 tipos, solo `sctr_salud`, `sctr_pension` y `vida_ley`, y que `tipo` esté dentro de la lista.
- En `seguro_cobertura`:
  - `estado`: `null` = incluida, como hoy. Los otros valores son `solicitada`, `incluida` y `excluida`.
  - `solicitada_en`: obligatoria cuando `estado` es `solicitada`.
  - `constancia_url` y `nota`.
  - Una fila `excluida` exige `hasta`: una baja sin fecha no dice desde cuándo dejó de cubrir.
- Un índice parcial `(seguro_id) where estado = 'solicitada'` para la lista de inclusiones pendientes.

**04b** (la vista): `v_seguro_persona` conserva sus 6 columnas en el mismo orden y tipo (`tabla text`, `persona_id bigint`, `tipo text`, `vencimiento date`, `fuente text`, `seguro_id bigint`). Agrega al final tres columnas:

- `inclusion`: `'solicitada'`, `'por_iniciar'` o `null`.
- `inclusion_fecha date`.
- `inclusion_seguro_id bigint`.

`fuente` pasa a admitir un valor nuevo, `'pendiente'`.

## La regla (gana el primer paso)

`hoy` = fecha de Lima. Para cada persona × tipo, las coberturas candidatas son las filas de `seguro_cobertura` de esa persona cuya póliza cubre ese tipo, con `tipo = any(coalesce(seguros.coberturas, array[seguros.tipo]))`. Cada candidata tiene tres datos:

- `est = coalesce(estado, 'incluida')`
- `ini = coalesce(desde, seguros.fecha_inicio)`
- `fin = coalesce(hasta, seguros.fecha_vencimiento)`

1. **Vigente**: alguna candidata con `est <> 'solicitada'`, `ini` null o `<= hoy`, y `fin >= hoy`. El resultado es `vencimiento` = el `fin` más lejano (si empatan, gana el `seguro_id` mayor), `fuente 'poliza'` y `seguro_id` de esa póliza. `inclusion` va en null.
2. **Pendiente**: alguna candidata con `est = 'solicitada'`, o con `est = 'incluida'` e `ini > hoy`. El resultado es `vencimiento` null, `fuente 'pendiente'` y `seguro_id` null, **sin caer a la ficha**. Se llenan `inclusion`, `inclusion_fecha` (`solicitada_en` o `ini`) e `inclusion_seguro_id`.
   - Si hay varias: **`por_iniciar` gana a `solicitada`**, porque es una cobertura ya confirmada con fecha de arranque. Dentro de cada grupo gana la fecha más temprana y, si empatan, el `seguro_id` mayor.
   - Una fila `excluida` con inicio futuro **no** cuenta como `por_iniciar`: es una baja, no una inclusión.
3. **Vencida o dada de baja**: alguna candidata con `est <> 'solicitada'`, `ini` null o `<= hoy`, y `fin` no null, aunque ya pasó. El resultado es `vencimiento` = el `fin` más lejano (mismo desempate), `fuente 'poliza'` y su `seguro_id`.
4. **Ficha**: igual que `seguros-03`; Vida Ley solo cuenta si `vida_ley = true`. El resultado es `fuente 'ficha'`.
5. Si no se cumple ninguno: todo null.

Sin `estado`, sin `coberturas` y sin inicios futuros, la vista da exactamente lo mismo que la de `seguros-03`. Así se probó en Postgres 16: cero filas distintas. Ojo: una póliza con `fecha_inicio > hoy` que ya existe hoy pasa de `poliza` a `pendiente · por_iniciar`. La segunda consulta de verificación sirve para encontrarlas antes de correr la migración.

## Verificación

```sql
select fuente, inclusion, count(*) from public.v_seguro_persona group by 1,2;
select id, tipo, fecha_inicio from public.seguros where fecha_inicio > current_date;
```

## Si no se corre

- **Sin 04a**: la app debe quitar `coberturas`, `estado`, `solicitada_en`, `constancia_url` y `nota` cuando el error nombre la columna que falta.
- **Sin 04b**: la vista no publica `inclusion`, y el código debe tratar esas columnas como ausentes.
