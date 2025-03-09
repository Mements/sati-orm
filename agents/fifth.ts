import { z } from 'zod';
import { Agent } from '../src/sati';

const inputSchema = z.object({
  message: z.string()
});

const outputSchema = z.object({
  response: z.string()
});

type InputType = z.infer<typeof inputSchema>;
type OutputType = z.infer<typeof outputSchema>;

const agent = Agent<typeof inputSchema, typeof outputSchema>('fifth')
  .init(inputSchema, outputSchema);

export async function processMessage(input: InputType): Promise<OutputType> {
  return {
    response: `Echo: ${input.message}`
  };
}

export default agent;