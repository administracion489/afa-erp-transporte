-- supabase/alertas-jornada-conduccion.sql
-- La alerta «jornada» pasa de medir la AMPLITUD del día (primera salida → último fin, > 13 h, o
-- ≥ 4 servicios) a medir HORAS DE CONDUCCIÓN según el RENAT (D.S. 017-2009-MTC, art. 30):
-- ≤ 5 h seguidas de día / 4 h de noche, descanso ≥ 1 h (30 min tras < 2 h), ≤ 10 h en el día.
-- El motor está en lib/alertas-flota.ts (evaluarJornada); no hace falta este SQL para que
-- funcione: el deploy ya cambia la regla.
--
-- Lo que hace este archivo: el umbral de la tarjeta («Horas máx. de conducción en el día»)
-- se sembró en 13 cuando significaba AMPLITUD. Leído como conducción, 13 h deja pasar 3 h más
-- de lo que permite la norma (la pantalla lo avisa en ámbar). Se baja a 10 SOLO si sigue en el
-- 13 sembrado: si alguien ya puso otro número, esa decisión se respeta.
--
-- Se corre ENTERO con Run en el SQL Editor de Supabase. Es idempotente.

update public.alerta_config
   set umbral = 10
 where clave = 'jornada'
   and umbral = 13;

-- La descripción guardada ya no se muestra (la tarjeta compone la suya desde el motor), pero
-- se deja diciendo lo mismo para quien consulte la tabla directo.
update public.alerta_config
   set descripcion = 'Conductor que pasa los topes de conducción del RENAT (horas al volante, no amplitud del día)'
 where clave = 'jornada';

-- Revisión: debe salir umbral = 10 (o el número que alguien eligió a propósito).
select clave, nombre, umbral, activo, hora_fija
  from public.alerta_config
 where clave = 'jornada';

-- FIN de alertas-jornada-conduccion.sql
