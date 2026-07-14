-- Vincula cada unidad real de flota (vehiculos / vehiculos_tercero) con su categoría
-- abstracta de costeo (parametros_costos.tipo_vehiculo), usada por /cotizador y /tarifario.
-- Sin esto, elegir una unidad real en /cotizaciones no completa tipo_vehiculo y la
-- cotización nunca puede servir de referencia de precio en /tarifario.

alter table vehiculos add column if not exists tipo_vehiculo_costeo text;
alter table vehiculos_tercero add column if not exists tipo_vehiculo_costeo text;
