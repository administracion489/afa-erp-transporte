-- Agrega updated_at a tarifario para poder marcar tarifas desactualizadas en /tarifario.
-- Cada UPDATE de fila (edición manual o desde la matriz) refresca updated_at automáticamente vía trigger.

alter table tarifario add column if not exists updated_at timestamptz not null default now();

create or replace function tarifario_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_tarifario_updated_at on tarifario;
create trigger trg_tarifario_updated_at
before update on tarifario
for each row
execute function tarifario_set_updated_at();
