-- supabase/mensajes-pasajero-chat.sql
-- Convierte mensajes_pasajero (buzón de 1 vía pasajero→operador) en un HILO
-- bidireccional 1-a-1: operador y conductor pueden responder, y cada respuesta
-- llega SOLO a ese pasajero. Idempotente (IF NOT EXISTS): correr en el SQL editor.
--
-- Modelo del hilo: la conversación se agrupa por (pasajero_id, reserva_id).
-- Las filas históricas (todas pasajero→operador) quedan como remitente='pasajero'.

alter table mensajes_pasajero
  -- Quién envió esta línea del hilo: 'pasajero' | 'operador' | 'conductor'.
  add column if not exists remitente text not null default 'pasajero',
  -- Nombre a mostrar del que respondió (p.ej. "Central AFA" o "Conductor Juan").
  add column if not exists autor_nombre text,
  -- Id del autor de la respuesta (usuarios.id del operador o conductores*.id).
  add column if not exists autor_id text,
  -- Estado de lectura del lado del PASAJERO (para respuestas operador/conductor→pasajero).
  -- El lado del operador ya usa las columnas existentes: leido / leido_por / leido_at.
  add column if not exists leido_pasajero boolean not null default false,
  add column if not exists leido_pasajero_at timestamptz;

-- Índice para la bandeja del operador y el hilo del pasajero/conductor.
create index if not exists idx_mensajes_pax_thread
  on mensajes_pasajero (pasajero_id, reserva_id, created_at);

-- Chequeo suave del dominio de remitente (no rompe si ya existe).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'mensajes_pasajero_remitente_chk'
  ) then
    alter table mensajes_pasajero
      add constraint mensajes_pasajero_remitente_chk
      check (remitente in ('pasajero', 'operador', 'conductor'));
  end if;
end $$;
