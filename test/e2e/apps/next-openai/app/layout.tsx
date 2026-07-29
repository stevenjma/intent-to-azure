export const metadata = {
  title: "next-openai",
  description: "Next.js chat app using the OpenAI SDK for the azx E2E harness.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
