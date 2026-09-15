-- ============================================================================
-- Las cuentas bancarias de la empresa, en la ficha de la empresa.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- EL DEFECTO QUE CIERRA, Y ES EL MÁS CARO DE TODOS LOS DE SU FAMILIA
--
-- El PDF de la cotización imprimía «Nuestras cuentas bancarias» con el número de cuenta y el
-- CCI de una empresa concreta ESCRITOS A MANO dentro del HTML. Los otros literales de ese
-- archivo imprimían un nombre equivocado; este manda el dinero al destinatario equivocado: un
-- comprador del ERP cotiza, su cliente lee «nuestras cuentas» y transfiere… a la cuenta de otro.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Y LA PANTALLA YA PROMETÍA ESTE CAMPO
--
-- `/cotizaciones/plantillas`, con «usar bancos propios» apagado, dice desde siempre: «Se usarán
-- las cuentas configuradas en Perfil Empresa · Ve a Configuración → Perfil Empresa para editar
-- las cuentas bancarias». Ese campo no existía. Una pantalla que promete algo que el sistema no
-- hace es el error que este ERP ya pagó varias veces.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUÉ AQUÍ Y NO EN LA PLANTILLA DEL PDF
--
-- `cot_plantilla_config` ya tiene `banco_1..3_{nombre,cuenta,cci}`, y se quedan: son las cuentas
-- que una plantilla concreta usa EN LUGAR de las de la empresa (para eso existe
-- `usar_bancos_propios`). Pero la cuenta a la que te pagan es de la EMPRESA, no de un diseño de
-- PDF: con tres plantillas, el mismo número vivía en tres sitios y cambiar de banco obligaba a
-- corregirlo tres veces. Una fila autoritativa, y la plantilla la referencia o la reemplaza.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SIN CUENTAS NO SE IMPRIME EL BLOQUE — ni un encabezado vacío ni un ejemplo. Un «Nuestras
-- cuentas bancarias» sin nada debajo se lee como un documento a medio hacer, y cualquier número
-- de relleno es plata mandada a donde no es. Misma regla que la autorización del regulador.
--
-- Y POR ESO ESTE ARCHIVO NO SIEMBRA NINGUNA CUENTA. Escribir aquí las de AFA las metería en una
-- migración que viaja con el producto. Se teclean una vez en /configuracion/perfil.
-- ============================================================================

ALTER TABLE public.empresa_perfil
  ADD COLUMN IF NOT EXISTS cuentas_bancarias jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.empresa_perfil.cuentas_bancarias IS
  'Cuentas donde la empresa cobra, como arreglo de objetos {banco, cuenta, cci}. Se imprimen en '
  'el PDF de la cotización. Vacío = el bloque no se imprime; nunca un ejemplo, que sería plata '
  'mandada a donde no es. Una plantilla puede reemplazarlas con usar_bancos_propios.';

-- Que sea un ARREGLO y no cualquier jsonb: el PDF lo recorre, y un objeto suelto o un número
-- reventarían al imprimir en vez de al guardar. Barato de comprobar aquí, caro de descubrir allá.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'empresa_perfil_cuentas_es_arreglo') THEN
    ALTER TABLE public.empresa_perfil
      ADD CONSTRAINT empresa_perfil_cuentas_es_arreglo
      CHECK (jsonb_typeof(cuentas_bancarias) = 'array');
  END IF;
END $$;

-- ── COMPROBACIÓN ────────────────────────────────────────────────────────────
-- Lo que hay que ver: la columna existe. Si sale 0 cuentas, tecléalas en
-- /configuracion/perfil → «Cuentas bancarias»; hasta entonces la cotización se imprime sin ese
-- bloque, que es lo correcto.
SELECT nombre,
       jsonb_array_length(cuentas_bancarias) AS cuentas,
       cuentas_bancarias,
       CASE WHEN jsonb_array_length(cuentas_bancarias) = 0
            THEN 'sin cuentas — la cotización se imprime sin ese bloque'
            ELSE 'ok' END AS diagnostico
  FROM public.empresa_perfil
 WHERE id = 1;
