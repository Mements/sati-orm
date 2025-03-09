import { Agent } from './sati';
import { insertAndWait } from './agent-helper';
import { z } from 'zod';

// Define the same schemas as the agent
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

// Initialize the agent client
const moderatorAgent = Agent('telegram_moderator').init(inputSchema, outputSchema);

// Function to process a new message
async function onTelegramMessage(userId: string, chatId: string, messageText: string) {
  console.log(`New message from ${userId}: ${messageText}`);
  
  try {
    // Insert the message and wait for processing
    const result = await insertAndWait(moderatorAgent, {
      user_id: userId,
      chat_id: chatId,
      message: messageText
    });
    
    console.log(`Got moderation result: ${result.output.action}`);
    
    // Handle based on action
    switch (result.output.action) {
      case 'allow':
        console.log(`Message allowed: ${result.output.reason}`);
        // Handle allowed message
        break;
        
      case 'verify':
        console.log(`Verification needed: ${result.output.question}`);
        // Send verification question
        // Example: await sendTelegramMessage(chatId, result.output.question);
        break;
        
      case 'block':
        console.log(`Message blocked: ${result.output.reason}`);
        // Block user or remove message
        // Example: await blockTelegramUser(userId, chatId);
        break;
    }
    
    return result;
  } catch (error) {
    console.error(`Error processing message:`, error);
    throw error;
  }
}

// Example usage
async function runExample() {
  try {
    // Test with a normal message
    console.log("\nTesting normal message:");
    await onTelegramMessage("user123", "chat456", "Hello, how are you today?");
    
    // Test with a spam message
    console.log("\nTesting spam message:");
    await onTelegramMessage("user123", "chat456", "Click here for free money and discount!");
    
    // Test with a short message
    console.log("\nTesting short message:");
    await onTelegramMessage("user123", "chat456", "hi");
    
    // Test with an abusive message
    console.log("\nTesting abusive message:");
    await onTelegramMessage("user123", "chat456", "You're so stupid!");
  } catch (error) {
    console.error("Example failed:", error);
  }
}

// Run the example if this is the main module
if (import.meta.main) {
  console.log("Running example client...");
  runExample().finally(() => console.log("Example complete"));
}