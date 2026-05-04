"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validando, setValidando] = useState(true);
  const [entrando, setEntrando] = useState(false);

  useEffect(() => {
    let activo = true;

    async function revisarSesion() {
      try {
        const sesionPromise = supabase.auth.getSession();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout validando sesión")), 3000)
        );

        const resultado = (await Promise.race([
          sesionPromise,
          timeoutPromise,
        ])) as Awaited<ReturnType<typeof supabase.auth.getSession>>;

        if (!activo) return;

        if (resultado.data.session) {
          router.replace("/dashboard");
          return;
        }
      } catch (error) {
        console.warn("No se pudo validar la sesión:", error);
      } finally {
        if (activo) {
          setValidando(false);
        }
      }
    }

    revisarSesion();

    return () => {
      activo = false;
    };
  }, [router]);

  async function handleLogin() {
    if (entrando) return;

    if (!email.trim() || !password.trim()) {
      alert("Ingresa correo y contraseña");
      return;
    }

    setEntrando(true);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        alert("Credenciales incorrectas");
        return;
      }

      router.replace("/dashboard");
      router.refresh();
    } catch (error) {
      console.error("Error al iniciar sesión:", error);
      alert("Error al iniciar sesión");
    } finally {
      setEntrando(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !entrando) {
      handleLogin();
    }
  }

  if (validando) {
    return (
      <div className="text-center py-8">
        <div className="mx-auto mb-5 h-14 w-14 animate-spin rounded-full border-4 border-gray-200 border-t-[#0b315f]" />
        <h2 className="text-xl font-black text-[#0b315f]">
          Validando sesión
        </h2>
        <p className="text-sm text-gray-500 mt-2">
          Estamos preparando tu ERP...
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-center mb-6">
        <img src="/logoafa.png" alt="AFA Transportes" className="w-52" />
      </div>

      <h1 className="text-3xl font-black text-center text-[#0b315f]">
        Login ERP
      </h1>

      <p className="text-center text-gray-500 text-sm mt-2 mb-8">
        Sistema de Gestión AFA TOURS
      </p>

      <div className="space-y-4">
        <input
          type="email"
          placeholder="Correo"
          className="w-full border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={entrando}
          autoComplete="email"
        />

        <input
          type="password"
          placeholder="Contraseña"
          className="w-full border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={entrando}
          autoComplete="current-password"
        />

        <button
          onClick={handleLogin}
          disabled={entrando}
          className="w-full bg-[#0b315f] hover:bg-[#08284f] text-white py-3 rounded-xl font-bold disabled:opacity-60 transition flex items-center justify-center gap-2"
        >
          {entrando && (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {entrando ? "Ingresando..." : "Entrar"}
        </button>
      </div>
    </div>
  );
}