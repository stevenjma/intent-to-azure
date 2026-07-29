export const metadata = {
  title: "next-prisma-postgres",
  description: "Next.js app backed by Prisma + PostgreSQL for the azx E2E harness.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
