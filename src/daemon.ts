#!/usr/bin/env bun

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
          const dbPath = join(DB_DIR, 'agents', `${agentName}.sqlite`);
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