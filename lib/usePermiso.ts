"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

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

      const { data: usuario } = await supabase
        .from("usuarios")
        .select("activo")
        .eq("id", session.user.id)
        .maybeSingle();

      if (!usuario || usuario.activo === false) {
        await supabase.auth.signOut();
        router.replace("/login");
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