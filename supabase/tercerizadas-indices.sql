-- Índices para /tercerizadas a escala (rediseño 2026-08-09).
--
-- Las 4 tablas de tercerizados se crearon a mano en el panel de Supabase y su DDL nunca se
-- versionó: hoy NO existe ni un solo índice sobre ellas, ni siquiera sobre `empresa_id`, que
-- es la columna por la que TODA la pantalla agrupa. Con 16 proveedores no se nota; con 1000
-- proveedores y miles de unidades cada apertura de ficha es un seq scan.
--
-- Idempotente: se puede correr las veces que haga falta.

-- Detalle bajo demanda: al abrir la ficha se piden las 3 colecciones por empresa_id.
create index if not exists idx_veh_terc_emp   on public.vehiculos_tercero   (empresa_id);
create index if not exists idx_cond_terc_emp  on public.conductores_tercero (empresa_id);
create index if not exists idx_doc_terc_emp   on public.documentos_tercero  (empresa_id, fecha_vencimiento);

-- Búsqueda por placa y orden estable del índice global (paginado con .range()).
create index if not exists idx_veh_terc_placa on public.vehiculos_tercero   (placa);
create index if not exists idx_emp_terc_rs    on public.empresas_tercerizadas (razon_social);

-- Semáforo de licencias y cruce documento ↔ unidad.
create index if not exists idx_cond_terc_lic  on public.conductores_tercero (vencimiento_licencia);
create index if not exists idx_doc_terc_veh   on public.documentos_tercero  (vehiculo_id);

-- Lecturas de odómetro por unidad tercerizada (badge "por revisar" de la ficha).
create index if not exists idx_lect_odo_terc  on public.lecturas_odometro   (vehiculo_tercero_id, estado);
