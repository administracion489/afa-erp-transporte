-- empresa-04-moneda-cuentas.sql — Declara la MONEDA de las cuentas bancarias del perfil que hoy no la dicen.
-- Una cuenta sin moneda se imprime en las DOS (PDF en soles y en dólares, y el pedido de adelanto de la IA): a un
-- cliente que paga en soles le salía también la cuenta en dólares, y al revés. /configuracion/perfil ya tiene el
-- selector «Moneda» por cuenta (empresa_perfil.cuentas_bancarias es jsonb, sin columna nueva); esto lo llena UNA vez
-- leyendo lo que la propia empresa escribió en el NOMBRE de la cuenta («BCP — Soles», «BBVA Dólares», «… US$»).
--   · Solo toca una cuenta SIN moneda, y solo si su nombre nombra UNA moneda (soles o dólares, no las dos).
--   · Una cuenta que ya dice su moneda, o cuyo nombre no lo dice, queda tal cual: se declara a mano en Perfil.
--   · No cambia bancos, números ni CCI, ni el orden de las cuentas.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente (la segunda vez no cambia nada).
-- Efecto: una cotización en soles deja de imprimir la cuenta en dólares (y al revés). Una cotización ya enviada
-- imprime lo mismo que antes hasta que se vuelva a generar su PDF.

-- 1) Lo que hay HOY (solo el nombre y la moneda; el número no se enseña).
select (c.ord)::int as n, c.cta->>'banco' as banco, coalesce(nullif(c.cta->>'moneda', ''), '— sin declarar') as moneda_hoy
  from public.empresa_perfil p,
       lateral jsonb_array_elements(case when jsonb_typeof(p.cuentas_bancarias) = 'array' then p.cuentas_bancarias else '[]'::jsonb end)
         with ordinality as c(cta, ord);

-- 2) Declara la moneda que dice el nombre.
update public.empresa_perfil p
   set cuentas_bancarias = (
     select coalesce(jsonb_agg(
              case
                when upper(coalesce(c.cta->>'moneda', '')) in ('PEN', 'USD') then c.cta
                when upper(coalesce(c.cta->>'banco', '')) ~ '(SOLES|\mPEN\M|S/)'
                 and upper(coalesce(c.cta->>'banco', '')) !~ '(D[OÓ]LAR|\mUSD\M|US\$)' then c.cta || '{"moneda":"PEN"}'::jsonb
                when upper(coalesce(c.cta->>'banco', '')) ~ '(D[OÓ]LAR|\mUSD\M|US\$)'
                 and upper(coalesce(c.cta->>'banco', '')) !~ '(SOLES|\mPEN\M|S/)' then c.cta || '{"moneda":"USD"}'::jsonb
                else c.cta
              end order by c.ord), '[]'::jsonb)
       from jsonb_array_elements(p.cuentas_bancarias) with ordinality as c(cta, ord))
 where jsonb_typeof(p.cuentas_bancarias) = 'array'
   and jsonb_array_length(p.cuentas_bancarias) > 0;

-- 3) Cómo quedó. «— sin declarar» = el nombre no dice la moneda: declárala en Configuración → Perfil.
select (c.ord)::int as n, c.cta->>'banco' as banco, coalesce(nullif(c.cta->>'moneda', ''), '— sin declarar') as moneda_ahora
  from public.empresa_perfil p,
       lateral jsonb_array_elements(case when jsonb_typeof(p.cuentas_bancarias) = 'array' then p.cuentas_bancarias else '[]'::jsonb end)
         with ordinality as c(cta, ord);

-- FIN de empresa-04-moneda-cuentas.sql
