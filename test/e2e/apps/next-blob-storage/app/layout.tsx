export const metadata = {
  title: "next-blob-storage",
  description: "Next.js app using Azure Blob Storage for the azx E2E harness.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
