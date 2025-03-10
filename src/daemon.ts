#!/usr/bin/env bun

/*
todo: okay so now we have this sati-daemon running in background which executes function for agents, now we need to write a new package sati-telegram for integration with telegram so it can work like this we should be able to write client program like this:

onTelegramMessage(async (msg, { addButtons, appendResponse }) => {
    (in this case we insert first not call so agent function is not invoked because our sati-telegram package implements this practical workflow where we wait first for user to click a button under a message which appears here once we insert it always happen that way)
    await agent.insert({
        group: msg.chat_id,
        text: msg.text,
    }, null);

    (so our package should implement something like addButton here)
    addButtons({
        'Process It': async (progress) => 
            progress(10)
            (maybe we dont even need to insert that above because we already have it in lexical scope of closure)
            const result = await agent.call({
                group, text
            })
            (and so such an agent lets say executes its workflow and it returns audio or something)
            (so it sends an audio file as response by editing original message attaching audio file to it)
            progress(99)
            await sleep(1000)
            replyResponse(result)
            (its important that when function callback of the button when "Process it " was pressed then buttons are removed and message is updated with a suffix in bold text showing a progress thats why we also have this progress function we invoke it update that text multiple times and finally when response is send then original message is suffixed with success message and possibly has media files attached to it so this is our framework for managing personal ai workflows in telegram)
        },
        'Forget It': () => {},
    })
})
*/

import { measure } from './helpers';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const AGENTS_DIR = process.env.SATI_AGENTS_DIR || './agents';
const DB_DIR = process.env.SATI_DB_DIR || join(process.env.HOME || '.', '.mements');
const WS_PORT = parseInt(process.env.WS_PORT || '3333');

if (import.meta.main) {
  measure(async (measure) => {
    console.log(`Starting sati-daemon on port ${WS_PORT}`);

    const server = Bun.serve({
      port: WS_PORT,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Only WebSocket connections are accepted.", { status: 400 });
      },
      websocket: {
        async message(ws, message) {
          await measure(async () => {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'subscribe' && data.agent) {
              ws.subscribe(data.agent);
              
              ws.send(JSON.stringify({ 
                type: 'subscribed', 
                agent: data.agent 
              }));
              
              console.log(`Client subscribed to agent: ${data.agent}`);
            }
            else if (data.type === 'new_task' && data.agent && data.id) {
              const { agent: agentName, id } = data;
              
              console.log(`New task received: ${id} for agent ${agentName}`);
              
              try {
                await measure(async () => {
                  await processTask(server, agentName, id);
                }, `Process task ${id} for ${agentName}`);
              } catch (error) {
                console.error(`Error processing task ${id} for ${agentName}:`, error);
              }
            }
          }, "Process WebSocket message");
        },
        
        async open(ws) {
          console.log("WebSocket client connected");
        },
        
        async close(ws) {
          console.log("WebSocket client disconnected");
        },
      },
    });

    console.log(`sati-daemon running, WebSocket server on port ${WS_PORT}`);

    async function processTask(server: any, agentName: string, taskId: string) {
      await measure(async () => {
        try {
          const dbPath = join(DB_DIR, `${agentName}.sqlite`);
          const db = new Database(dbPath);
          
          const inputRecord = db.query(`
            SELECT * FROM input WHERE id = ?
          `).get(taskId);
          
          if (!inputRecord) {
            console.error(`Input record ${taskId} not found for agent ${agentName}`);
            return;
          }
          
          const input = extractInput(inputRecord);
          console.log(`Processing input for task ${taskId}: `, input);
          
          const agentModule = await measure(
            async () => import(join(AGENTS_DIR, `${agentName}.js`)), 
            `Import agent module ${agentName}`
          );
          
          if (typeof agentModule.processMessage !== 'function') {
            throw new Error(`Agent ${agentName} doesn't export a processMessage function`);
          }
          
          const output = await agentModule.processMessage(input);
          
          storeOutput(db, taskId, output);
          
          server.publish(agentName, JSON.stringify({
            type: 'update',
            agent: agentName,
            data: { id: taskId, input_id: taskId }
          }));
          
          console.log(`Task ${taskId} completed for agent ${agentName}`);
        } catch (error) {
          console.error(`Failed to process task ${taskId} for agent ${agentName}:`, error);
        }
      }, `Process task ${taskId} for ${agentName}`);
    }
    
    function extractInput(record: any): any {
      const input: Record<string, any> = {};
      
      for (const [key, value] of Object.entries(record)) {
        if (key === 'id') {
          input.id = value;
          continue;
        }
        
        if (key.endsWith('_json')) {
          const baseKey = key.slice(0, -5);
          try {
            input[baseKey] = JSON.parse(value as string);
          } catch (e) {
            input[baseKey] = value;
          }
        } else {
          input[key] = value;
        }
      }
      
      return input;
    }
    
    function storeOutput(db: Database, id: string, output: any): void {
      const flatOutput: Record<string, any> = { id };
      
      for (const [key, value] of Object.entries(output)) {
        if (typeof value === 'object' && value !== null) {
          flatOutput[`${key}_json`] = JSON.stringify(value);
        } else {
          flatOutput[key] = value;
        }
      }
      
      const keys = Object.keys(flatOutput);
      const placeholders = keys.map(() => '?').join(', ');
      const values = Object.values(flatOutput);
      
      try {
        const existing = db.query('SELECT id FROM output WHERE id = ?').get(id);
        
        if (existing) {
          const setClause = keys.map(k => `${k} = ?`).join(', ');
          db.query(`UPDATE output SET ${setClause} WHERE id = ?`).run(...values, id);
        } else {
          db.query(`INSERT INTO output (${keys.join(', ')}) VALUES (${placeholders})`).run(...values);
        }
      } catch (error) {
        console.error(`Error storing output for ${id}:`, error);
        throw error;
      }
    }
  }, "Run sati-daemon").catch(error => {
    console.error("Failed to start daemon:", error);
    process.exit(1);
  });

  // Shutdown handlers
  process.on('SIGINT', () => {
    console.log("sati-daemon stopped via SIGINT");
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log("sati-daemon stopped via SIGTERM");
    process.exit(0);
  });
}