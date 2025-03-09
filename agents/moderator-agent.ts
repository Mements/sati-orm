#!/usr/bin/env bun
import { z } from 'zod';
import { createAgentHandler } from '../agent-helper';

// Define schemas
const inputSchema = z.object({
  user_id: z.string(),
  chat_id: z.string(),
  message: z.string()
});

const outputSchema = z.object({
  action: z.enum(['allow', 'verify', 'block']),
  question: z.string().optional(),
  reason: z.string()
});

// Define database name
export const dbName = 'telegram_moderator';

// Define processing function
export async function processMessage(input: z.infer<typeof inputSchema>): Promise<z.infer<typeof outputSchema>> {
  console.log(`Processing message from user ${input.user_id}`);
  
  // Simple analysis logic - detect spam/abuse keywords
  const lowercaseMessage = input.message.toLowerCase();
  
  const spamKeywords = ['buy now', 'discount', 'free money', 'click here'];
  const abuseKeywords = ['idiot', 'stupid', 'hate'];
  
  // Check for spam
  const hasSpam = spamKeywords.some(keyword => lowercaseMessage.includes(keyword));
  
  // Check for abuse
  const hasAbuse = abuseKeywords.some(keyword => lowercaseMessage.includes(keyword));
  
  // Decision logic
  if (hasSpam) {
    return {
      action: 'block',
      reason: 'Message contains spam patterns'
    };
  } else if (hasAbuse) {
    return {
      action: 'block',
      reason: 'Message contains abusive language'
    };
  } else if (input.message.length < 5) {
    // Very short message - might be a bot
    return {
      action: 'verify',
      question: 'Please verify you are human by typing the name of our planet',
      reason: 'Short message verification'
    };
  } else {
    // Seems fine
    return {
      action: 'allow',
      reason: 'Message appears normal'
    };
  }
}

// Create and export the agent handler
export default createAgentHandler(
  dbName,
  inputSchema,
  outputSchema,
  processMessage
);