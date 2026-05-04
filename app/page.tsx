"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/login");
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#eef3f8]">
      <p className="font-bold text-[#0b315f]">Cargando ERP...</p>
    </div>
  );
}