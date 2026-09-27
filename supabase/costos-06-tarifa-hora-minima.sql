-- Precio mínimo por hora de cada tipo de unidad (SIN IGV, margen incluido).
-- Lo usa el cotizador como PISO para servicios cortos que el mercado cobra por tiempo
-- (city tour, disposición). NULL = sin piso: el comportamiento de siempre.
-- No se siembra ningún valor: es un precio de mercado que decide una persona
-- (referencia AFA set-2026: bus 50 pax Full Equipo ≈ S/ 180/hora).
alter table public.parametros_costos
  add column if not exists tarifa_hora_minima numeric(10,2);
