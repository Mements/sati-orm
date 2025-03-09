import { agent } from '../agents/sixth';

async function sendMessage(message: string) {
  const result = await agent.call({
    'message': message,
  });
  
  console.log(`Response: ${result.response}`);
  return result;
}

await sendMessage('message one');