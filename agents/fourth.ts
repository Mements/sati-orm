import { z } from 'zod';

export const inputSchema = z.object({
  query: z.string()
});

export const outputSchema = z.object({
  answer: z.string()
});

export type InputType = z.infer<typeof inputSchema>;
export type OutputType = z.infer<typeof outputSchema>;

export default async function(input: InputType): Promise<OutputType> {
  return {
    answer: `You asked: ${input.query}`
  };
}

if (import.meta.main) {
}