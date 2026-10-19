-- traslados-03-precios-afa.sql — SOLO AFA: categorías de traslado, sus precios y consideraciones.
-- NO la corre el deploy. Requiere traslados-01 y traslados-02. Idempotente: no pisa lo editado.
--
-- Este archivo trae datos COMERCIALES de AFA (precios del 19-10-2026). Una instalación de otra
-- empresa no lo corre: carga los suyos desde /tarifario → «Zonas y traslados».
--
-- Capacidad = asientos de pasajeros. maletas_bodega = maletas de 23 kg que van en bodega sin
-- ocupar asiento (minibús: maletera corta, 15; bus: 45). Sin bodega, cada maleta grande ocupa un
-- asiento: es la regla «con maletas, el doble de capacidad» escrita por maleta.
insert into public.traslado_categorias (clave, nombre, capacidad, maletas_bodega, tipo_vehiculo, orden) values
  ('AUTO',        'Auto 4 pax',                  4,  0, 'AUTO_4',      10),
  ('SUV',         'SUV 4 pax',                   4,  0, 'SUV_4',       20),
  ('H1',          'Minivan H1 10 pax',          10,  0, 'MINIVAN_10',  30),
  ('VAN_15',      'Sprinter corta (van) 15 pax', 15, 0, 'VAN_15',      40),
  ('SPRINTER_20', 'Sprinter larga 20 pax',      20,  0, 'SPRINTER_20', 50),
  ('MINIBUS',     'Minibús 25-30 pax',          30, 15, 'MINIBUS_30',  60),
  ('BUS',         'Bus 45-50 pax',              50, 45, 'BUS_50',      70)
on conflict (clave) do nothing;

-- Precio NETO por tramo (sin IGV). Soles para números peruanos (+51); dólares para el resto.
-- Aeropuerto ↔ Miraflores / San Isidro / Barranco, en los dos sentidos (el par no tiene sentido).
with aer as (
  select id from public.zonas_traslado where lower(nombre) = lower('Aeropuerto Jorge Chávez')
), dest as (
  select id from public.zonas_traslado
  where lower(nombre) in (lower('Miraflores'), lower('San Isidro'), lower('Barranco')) and tipo = 'distrito'
), p(categoria, pen, usd) as (
  values ('AUTO', 100, 30), ('SUV', 126, 36), ('H1', 200, 55), ('VAN_15', 300, 85),
         ('SPRINTER_20', 350, 100), ('MINIBUS', 750, 216), ('BUS', 900, 260)
)
insert into public.tarifas_traslado (zona_a_id, zona_b_id, categoria, moneda, precio_tramo)
select least(aer.id, dest.id), greatest(aer.id, dest.id), p.categoria, m.moneda,
       case m.moneda when 'PEN' then p.pen else p.usd end
from aer cross join dest cross join p cross join (values ('PEN'), ('USD')) as m(moneda)
on conflict (zona_a_id, zona_b_id, categoria, moneda) do nothing;

-- Consideraciones que irán en la cotización. Solo se escriben si están vacías.
update public.traslados_config set
  consideraciones = array[
    'Precios por tramo. No incluyen IGV (18 %).',
    'Incluye 30 minutos de espera gratis. No incluye el parqueo del aeropuerto por retraso de vuelo.',
    'Sujeto a disponibilidad: un ejecutivo confirma la reserva.'
  ],
  consideraciones_usd = array[
    'Precio turista: el IGV se exonera solo si los pasajeros presentan Tarjeta Andina de Migración (TAM) y pasaporte.'
  ]
where id = 1 and cardinality(consideraciones) = 0;
-- FIN de traslados-03-precios-afa.sql
