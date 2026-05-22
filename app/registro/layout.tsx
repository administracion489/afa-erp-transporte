export default function RegistroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body style={{ margin: 0, padding: 0, background: "#F4F6FA" }}>
        {children}
      </body>
    </html>
  );
}