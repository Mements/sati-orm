// @ts-nocheck
import { Agent } from './sati';
import { z } from 'zod';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const memberSchema = z.object({
  user_id: z.string(),
  chat_id: z.string()
});

const memberOutputSchema = z.object({
  status: z.string()
});

const moderatorSchema = z.object({
  user_id: z.string(),
  chat_id: z.string(),
  message: z.string()
});

const moderatorOutputSchema = z.object({
  question: z.string()
});

const chatsAgent = Agent('members').init(memberSchema, memberOutputSchema, { inferenceEngine: 'none' });
const moderatorAgent = Agent('moderator').init(moderatorSchema, moderatorOutputSchema);

const pendingVerifications = new Map();

async function onTelegramMessage(message) {
  const userId = message.from.id.toString();
  const chatId = message.chat.id.toString();
  const text = message.text;
  
  const member = await chatsAgent.find({ user_id: userId });
  
  if (!member.length) {
    console.log(`New user ${userId}: ${text}`);
    
    await chatsAgent.store({
      user_id: userId,
      chat_id: chatId
    }, {
      status: 'pending'
    });
    
    await moderatorAgent.insert({
      user_id: userId,
      chat_id: chatId,
      message: text
    });
    
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Your message is being reviewed."
    });
  } else {
    if (pendingVerifications.has(userId)) {

      const verification = pendingVerifications.get(userId);
      clearTimeout(verification.timer);
      pendingVerifications.delete(userId);
      
      await chatsAgent.edit(member[0].id, {}, { status: 'verified' });
      
      await tg("sendMessage", {
        chat_id: chatId,
        text: "✅ Verification successful!"
      });
    }
  }
}

moderatorAgent.listen(async ({ input, output }) => {
  const { user_id, chat_id } = input;
  const { question } = output;
  
  console.log(`Got moderation for ${user_id} with question: ${question}`);
  
  const sent = await tg("sendMessage", {
    chat_id,
    text: question + "\n\nPlease respond within a minute or be blocked."
  });
  
  const timer = setTimeout(async () => {
    console.log(`Verification timeout for ${user_id}`);
    pendingVerifications.delete(user_id);
    
    const members = await chatsAgent.find({ user_id });
    if (members.length) {
      await chatsAgent.edit(members[0].id, {}, { status: 'blocked' });
      
      await tg("kickChatMember", {
        chat_id,
        user_id
      });
      
      await tg("sendMessage", {
        chat_id,
        text: "⏰ Verification timeout. You have been removed."
      });
    }
  }, 60000);
  
  pendingVerifications.set(user_id, {
    messageId: sent.result?.message_id,
    timer
  });
});

async function startPolling() {
  let offset = 0;
  
  while (true) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30 });
      
      if (updates.ok && updates.result.length > 0) {
        for (const update of updates.result) {
          if (update.message && update.message.text) {
            await onTelegramMessage(update.message);
          }
          offset = update.update_id + 1;
        }
      }
    } catch (error) {
      console.error("Polling error:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

if (import.meta.main) {
  startPolling().catch(console.error);
}