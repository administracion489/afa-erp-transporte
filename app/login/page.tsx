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
    async function revisarSesion() {
      const { data } = await supabase.auth.getSession();

      if (data.session) {
        router.replace("/dashboard");
        return;
      }

      setValidando(false);
    }

    revisarSesion();
  }, [router]);

  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      alert("Ingresa correo y contraseña");
      return;
    }

    setEntrando(true);

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      setEntrando(false);
      alert("Credenciales incorrectas");
      return;
    }

    router.replace("/dashboard");
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
        />

        <input
          type="password"
          placeholder="Contraseña"
          className="w-full border border-gray-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-[#0b315f]"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={entrando}
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