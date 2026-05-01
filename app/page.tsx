export default function Home() {
  return (
    <main className="min-h-screen bg-slate-100 p-8 text-slate-900">
      <h1 className="mb-2 text-3xl font-bold">Panel de Control</h1>
      <p className="mb-8 text-slate-600">
        Sistema de gestión AFA TOURS
      </p>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
        <div className="rounded-xl bg-white p-6 shadow">
          <p className="text-slate-500">Clientes</p>
          <h2 className="text-3xl font-bold">0</h2>
        </div>

        <div className="rounded-xl bg-white p-6 shadow">
          <p className="text-slate-500">Reservas</p>
          <h2 className="text-3xl font-bold">0</h2>
        </div>

        <div className="rounded-xl bg-white p-6 shadow">
          <p className="text-slate-500">Ingresos</p>
          <h2 className="text-3xl font-bold">S/ 0</h2>
        </div>

        <div className="rounded-xl bg-white p-6 shadow">
          <p className="text-slate-500">Gastos</p>
          <h2 className="text-3xl font-bold">S/ 0</h2>
        </div>
      </div>
    </main>
  );
}