import { z } from 'zod';
import { Agent } from '../src/sati';

const inputSchema = z.object({
  message: z.string()
});

const outputSchema = z.object({
  response: z.string()
});

const agent = Agent<typeof inputSchema, typeof outputSchema>('sixth_agent');

if (!agent.exists) {
  agent.init(inputSchema, outputSchema);
}

export { inputSchema, outputSchema, agent };

export async function processMessage(input: z.infer<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
  return {
    response: `Echo: ${input.message}`
  };
}