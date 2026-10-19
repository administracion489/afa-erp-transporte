-- traslados-02-zonas-lima.sql — Los 50 distritos de Lima Metropolitana y Callao + el aeropuerto.
-- NO la corre el deploy. Requiere traslados-01-tablas.sql. Idempotente: no pisa lo ya editado.
--
-- Es geografía, no precios: sirve a cualquier empresa que opere en Lima. Las subzonas de los
-- distritos grandes (SJL, Ancón, Ventanilla, Lurín, Lurigancho…) se crean desde /tarifario
-- marcando su centro en el mapa: no se siembran coordenadas inventadas.
--
-- `alias` = otros nombres con que Google (o el cliente) llama al distrito. El nombre «Lima» a
-- secas NO es alias de nadie: Google lo usa también para direcciones de San Isidro o Lince, y
-- leerlo como Cercado cotizaría el distrito equivocado (lib/traslados/motor.ts lo trata aparte).

insert into public.zonas_traslado (nombre, tipo, sector, alias, orden) values
  ('Ancón', 'distrito', 'Lima Norte', '{}', 101),
  ('Carabayllo', 'distrito', 'Lima Norte', '{}', 102),
  ('Comas', 'distrito', 'Lima Norte', '{}', 103),
  ('Independencia', 'distrito', 'Lima Norte', '{}', 104),
  ('Los Olivos', 'distrito', 'Lima Norte', '{}', 105),
  ('Puente Piedra', 'distrito', 'Lima Norte', '{}', 106),
  ('San Martín de Porres', 'distrito', 'Lima Norte', '{SMP}', 107),
  ('Santa Rosa', 'distrito', 'Lima Norte', '{}', 108),
  ('Cercado de Lima', 'distrito', 'Lima Centro', '{"Lima Cercado"}', 201),
  ('Breña', 'distrito', 'Lima Centro', '{}', 202),
  ('La Victoria', 'distrito', 'Lima Centro', '{}', 203),
  ('Rímac', 'distrito', 'Lima Centro', '{}', 204),
  ('San Luis', 'distrito', 'Lima Centro', '{}', 205),
  ('Barranco', 'distrito', 'Lima Moderna', '{}', 301),
  ('Jesús María', 'distrito', 'Lima Moderna', '{}', 302),
  ('Lince', 'distrito', 'Lima Moderna', '{}', 303),
  ('Magdalena del Mar', 'distrito', 'Lima Moderna', '{Magdalena}', 304),
  ('Miraflores', 'distrito', 'Lima Moderna', '{}', 305),
  ('Pueblo Libre', 'distrito', 'Lima Moderna', '{}', 306),
  ('San Borja', 'distrito', 'Lima Moderna', '{}', 307),
  ('San Isidro', 'distrito', 'Lima Moderna', '{}', 308),
  ('San Miguel', 'distrito', 'Lima Moderna', '{}', 309),
  ('Santiago de Surco', 'distrito', 'Lima Moderna', '{Surco}', 310),
  ('Surquillo', 'distrito', 'Lima Moderna', '{}', 311),
  ('Ate', 'distrito', 'Lima Este', '{"Ate Vitarte","Vitarte"}', 401),
  ('Chaclacayo', 'distrito', 'Lima Este', '{}', 402),
  ('Cieneguilla', 'distrito', 'Lima Este', '{}', 403),
  ('El Agustino', 'distrito', 'Lima Este', '{}', 404),
  ('La Molina', 'distrito', 'Lima Este', '{}', 405),
  ('Lurigancho', 'distrito', 'Lima Este', '{"Lurigancho-Chosica","Chosica"}', 406),
  ('San Juan de Lurigancho', 'distrito', 'Lima Este', '{SJL}', 407),
  ('Santa Anita', 'distrito', 'Lima Este', '{}', 408),
  ('Chorrillos', 'distrito', 'Lima Sur', '{}', 501),
  ('Lurín', 'distrito', 'Lima Sur', '{}', 502),
  ('Pachacámac', 'distrito', 'Lima Sur', '{}', 503),
  ('San Juan de Miraflores', 'distrito', 'Lima Sur', '{SJM}', 504),
  ('Villa El Salvador', 'distrito', 'Lima Sur', '{VES}', 505),
  ('Villa María del Triunfo', 'distrito', 'Lima Sur', '{VMT}', 506),
  ('Pucusana', 'distrito', 'Balnearios del Sur', '{}', 601),
  ('Punta Hermosa', 'distrito', 'Balnearios del Sur', '{}', 602),
  ('Punta Negra', 'distrito', 'Balnearios del Sur', '{}', 603),
  ('San Bartolo', 'distrito', 'Balnearios del Sur', '{}', 604),
  ('Santa María del Mar', 'distrito', 'Balnearios del Sur', '{}', 605),
  ('Callao', 'distrito', 'Callao', '{"Cercado del Callao"}', 701),
  ('Bellavista', 'distrito', 'Callao', '{}', 702),
  ('Carmen de la Legua Reynoso', 'distrito', 'Callao', '{"Carmen de La Legua"}', 703),
  ('La Perla', 'distrito', 'Callao', '{}', 704),
  ('La Punta', 'distrito', 'Callao', '{}', 705),
  ('Ventanilla', 'distrito', 'Callao', '{}', 706),
  ('Mi Perú', 'distrito', 'Callao', '{}', 707)
on conflict ((lower(nombre))) do nothing;

-- El aeropuerto es una GEOCERCA: dentro de su radio manda sobre el distrito (Callao). Centro =
-- terminal nueva (Av. Morales Duárez); con 2 km entra también la terminal antigua (~0.9 km).
insert into public.zonas_traslado (nombre, tipo, sector, alias, lat, lng, radio_m, orden, notas) values
  ('Aeropuerto Jorge Chávez', 'punto', 'Callao',
   '{"Aeropuerto Internacional Jorge Chávez","LIM"}', -12.0297011, -77.1162278, 2000, 700,
   'Terminal nueva, Av. Morales Duárez s/n. Radio editable.')
on conflict ((lower(nombre))) do nothing;
-- FIN de traslados-02-zonas-lima.sql
