export const metadata = {
  title: "next-minimal",
  description: "Minimal stateless Next.js app for the azx E2E harness.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
