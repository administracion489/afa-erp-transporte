-- ============================================================================
-- combustible-06 · el RESPALDO de una carga registrada a mano
-- ============================================================================
-- El formulario de /combustible no guardaba ningún papel: una carga tecleada a mano no tenía
-- dónde llevar el voucher del grifo, la constancia ni la foto del tablero. Ahora se adjuntan
-- (opcional) y se guardan aquí como lista: [{ url, nombre, mime, clase }], clase = voucher |
-- tablero | constancia. La URL es el IDENTIFICADOR del archivo (bucket privado `documentos` para
-- voucher y constancia; `vehiculos-fotos` para el tablero) y la pantalla la firma al mostrarla —
-- ver lib/evidencia.ts y lib/storage-privado.ts.
--
-- Nullable y SIN default ni backfill: una carga vieja no tiene respaldo, y la ausencia ya significa
-- eso. Sin esta migración el formulario guarda la carga igual, sin el voucher, y lo DICE; la foto
-- del tablero sí queda en su lectura de odómetro (lecturas_odometro.foto_url ya existe).
--
-- NO la corre el deploy.
-- ============================================================================

alter table public.combustible add column if not exists evidencias jsonb;

comment on column public.combustible.evidencias is
  'Respaldo adjunto a mano: [{url, nombre, mime, clase: voucher|tablero|constancia}]. null = sin respaldo.';
