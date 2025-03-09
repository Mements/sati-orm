import { z } from 'zod';
import { Agent } from '../src/sati';

const inputSchema = z.object({
  message: z.string()
});

const outputSchema = z.object({
  response: z.string()
});

export const agent = Agent<typeof inputSchema, typeof outputSchema>('sixth_agent').init(inputSchema, outputSchema);

export { inputSchema, outputSchema };

export async function processMessage(input: z.infer<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
  return {
    response: `Echo: ${input.message}`
  };
}