#!/usr/bin/env bun
import { Agent } from '../sati';
import { z } from 'zod';

// Define schemas for chat members
const inputSchema = z.object({
  user_id: z.string(),
  chat_id: z.string()
});

const outputSchema = z.object({
  status: z.string()
});

// Initialize the agent - using the filename as the agent name
const agent = Agent('members').init(inputSchema, outputSchema, { inferenceEngine: 'none' });

// This agent doesn't actually need to process anything since it's just a storage
// But we still need a handler for the daemon to call

// Main handler - runs when file is invoked directly
if (import.meta.main) {
  try {
    // Get input ID from argument or environment variable
    const inputId = process.argv[2] || process.env.SATI_INPUT_ID;
    
    if (!inputId) {
      throw new Error("No input ID provided");
    }
    
    // This agent doesn't do any processing, just return the ID
    console.log(JSON.stringify({ id: inputId }));
    
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}