import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { messages } = await req.json();
  const completion = await client.chat.completions.create({
    model: "gpt-4o",
    messages,
  });
  return Response.json(completion.choices[0]?.message ?? {});
}
