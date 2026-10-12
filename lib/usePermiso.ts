"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// Guarda fina de una pantalla por módulo. EL ROL `admin` PASA SIEMPRE, igual que en el
// layout (que le da todos los módulos del menú) y en `verificarUsuarioApi` (lib/api-auth.ts):
// el administrador original no tiene filas en `permisos_usuario`, y sin esta rama el hook lo
// mandaba al dashboard — por eso Tesorería, Caja chica y /gps-salud lo esquivaban.
export function usePermiso(modulo: string) {
  const router = useRouter();
  const [validando, setValidando] = useState(true);
  const [permitido, setPermitido] = useState(false);

  useEffect(() => {
    async function validarPermiso() {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        router.replace("/login");
        return;
      }

      const { data: perfil } = await supabase
        .from("usuarios")
        .select("rol")
        .eq("id", session.user.id)
        .maybeSingle();

      if (perfil?.rol === "admin") {
        setPermitido(true);
        setValidando(false);
        return;
      }

      const { data: permiso } = await supabase
        .from("permisos_usuario")
        .select("permitido")
        .eq("usuario_id", session.user.id)
        .eq("modulo", modulo)
        .maybeSingle();

      if (!permiso?.permitido) {
        router.replace("/dashboard");
        return;
      }

      setPermitido(true);
      setValidando(false);
    }

    validarPermiso();
  }, [modulo, router]);

  return { validando, permitido };
}
