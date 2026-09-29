-- ═══════════════════════════════════════════════════════════════════════════
-- seguridad-00-diagnostico.sql · SOLO LEE. No cambia nada.
--
-- Contesta las dos alertas del Security Advisor de Supabase
-- (rls_disabled_in_public y sensitive_columns_exposed) y lo que el
-- Advisor NO avisa: tablas CON RLS pero con una política que deja pasar a
-- cualquiera (`using (true)` sin `to authenticated` = también el rol anon,
-- o sea cualquiera con la URL del proyecto y la anon key, que viaja en el
-- JavaScript público de transportesafa.com).
--
-- Córrelo en Supabase → SQL Editor y guarda el resultado ANTES de correr
-- seguridad-01-rls.sql, para poder comparar.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Tablas de `public` SIN RLS → las lee/edita/borra cualquiera con la anon key.
select 'SIN_RLS' as hallazgo, c.relname as tabla,
       (select string_agg(a.attname, ', ')
          from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
           and a.attname ~* '(pass|clave|pin|token|secret|dni|documento|ruc|telefono|celular|email|correo|licencia|cuenta|cci|sueldo|firma)'
       ) as columnas_sensibles
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
 order by 2;

-- 2) Políticas que dejan pasar al rol anon (o a PUBLIC, que lo incluye).
select 'POLITICA_ABIERTA_A_ANON' as hallazgo, tablename as tabla, policyname,
       cmd, roles, qual as using_expr, with_check
  from pg_policies
 where schemaname = 'public'
   and ('anon' = any(roles) or 'public' = any(roles))
   and coalesce(qual, 'true') !~* '(auth\.uid|auth\.role|auth\.jwt|authenticated|fn_es_|puede_|es_admin)'
 order by 2, 3;

-- 3) Vistas de `public` sin security_invoker: se ejecutan con los permisos
--    del DUEÑO (postgres) y se saltan el RLS de las tablas que leen.
select 'VISTA_SIN_SECURITY_INVOKER' as hallazgo, c.relname as vista
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
   and not coalesce((select bool_or(o = 'security_invoker=true' or o = 'security_invoker=on')
                       from unnest(c.reloptions) o), false)
 order by 2;

-- 4) Buckets públicos de Storage (cualquiera con la URL descarga el archivo).
select 'BUCKET_PUBLICO' as hallazgo, id as bucket from storage.buckets where public order by 2;

-- 5) Funciones SECURITY DEFINER en public ejecutables por anon.
select 'FUNCION_DEFINER_ANON' as hallazgo, p.proname as funcion
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('anon', p.oid, 'EXECUTE')
 order by 2;
