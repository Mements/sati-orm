import { Agent } from './sati';
import { z } from 'zod';

async function main() {
  const ticketSchema = z.object({
    customer: z.object({
      name: z.string(),
      email: z.string().email(),
      tier: z.enum(['free', 'pro', 'enterprise'])
    }),
    issue: z.string().describe('Customer problem description'),
    category: z.enum(['billing', 'technical', 'account']).optional()
  });

  const responseSchema = z.object({
    solution: z.string().describe('Response to customer'),
    internalNotes: z.string().describe('Notes for support team'),
    nextSteps: z.array(z.string()),
    category: z.enum(['billing', 'technical', 'account'])
  });

  const supportBot = Agent<typeof ticketSchema, typeof responseSchema>('support_bot').init(ticketSchema, responseSchema);

  const unsubscribe = supportBot.listen(output => {
    const { id, input, output: response } = output;
    console.log(`Received response for ticket ${id}:`);
    console.log(`Issue: ${input.issue}`);
    console.log(`Solution: ${response.solution}`);
    console.log(`Next steps: ${response.nextSteps.join(', ')}`);
  });

  const ticket = {
    customer: {
      name: "Jordan Smith",
      email: "jordan@example.com",
      tier: "pro"
    },
    issue: "I can't export my data to CSV. The export button is disabled.",
    category: "technical"
  };

  const { id } = await supportBot.insert(ticket);
  console.log(`Submitted ticket with ID: ${id}`);

  unsubscribe();
}

main().catch(console.error);
