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
            else if (data.type === 'insert_task' && data.agent && data.id) {
              const { agent: agentName, id, input } = data;
              console.log(`Inserting task ${id} for agent ${agentName}`);
              
              try {
                const dbPath = join(DB_DIR, `${agentName}.sqlite`);
                const db = new Database(dbPath);
                storeInput(db, id, input);
                db.close();
                
                ws.send(JSON.stringify({
                  type: 'inserted',
                  agent: agentName,
                  id: id
                }));
              } catch (error) {
                console.error(`Error inserting task ${id}:`, error);
                ws.send(JSON.stringify({
                  type: 'error',
                  agent: agentName,
                  id: id,
                  message: error.message
                }));
              }
            }
            else if (data.type === 'call_task' && data.agent && data.id) {
              const { agent: agentName, id } = data;
              console.log(`Processing task ${id} for agent ${agentName}`);
              
              try {
                await measure(async () => {
                  await processTask(server, agentName, id);
                }, `Process task ${id} for ${agentName}`);
              } catch (error) {
                console.error(`Error processing task ${id}:`, error);
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
          
          const inputRecord = db.query(`SELECT * FROM input WHERE id = ?`).get(taskId);
          if (!inputRecord) throw new Error(`Input record ${taskId} not found`);
          
          const input = extractInput(inputRecord);
          const agentModule = await import(join(AGENTS_DIR, `${agentName}.js`));
          
          if (typeof agentModule.processMessage !== 'function') {
            throw new Error(`Agent ${agentName} missing processMessage function`);
          }

          // Progress reporting callback
          const sendProgress = (progress: number) => {
            server.publish(agentName, JSON.stringify({
              type: 'progress',
              agent: agentName,
              id: taskId,
              progress
            }));
          };

          // Execute agent processing
          const output = agentModule.processMessage.length >= 2 
            ? await agentModule.processMessage(input, sendProgress)
            : await agentModule.processMessage(input);

          // Store and notify completion
          storeOutput(db, taskId, output);
          server.publish(agentName, JSON.stringify({
            type: 'update',
            agent: agentName,
            data: { id: taskId, input_id: taskId }
          }));
          
          db.close();
        } catch (error) {
          console.error(`Task processing failed:`, error);
          throw error;
        }
      }, `Process task ${taskId} for ${agentName}`);
    }
  }, "Run sati-daemon").catch(error => {
    console.error("Failed to start daemon:", error);
    process.exit(1);
  });

  // Database utilities
  function storeInput(db: Database, id: string, input: any) {
    const flatInput: Record<string, any> = { id };
    for (const [key, value] of Object.entries(input)) {
      flatInput[key + (typeof value === 'object' ? '_json' : '')] = 
        typeof value === 'object' ? JSON.stringify(value) : value;
    }

    const keys = Object.keys(flatInput);
    const values = Object.values(flatInput);
    
    db.query(
      keys.some(k => k === 'id') 
        ? `INSERT OR REPLACE INTO input (${keys}) VALUES (${keys.map(() => '?')})`
        : `UPDATE input SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`
    ).run(...values);
  }

  function storeOutput(db: Database, id: string, output: any) {
    const flatOutput: Record<string, any> = { id };
    for (const [key, value] of Object.entries(output)) {
      flatOutput[key + (typeof value === 'object' ? '_json' : '')] = 
        typeof value === 'object' ? JSON.stringify(value) : value;
    }

    const keys = Object.keys(flatOutput);
    const values = Object.values(flatOutput);
    
    db.query(
      `INSERT OR REPLACE INTO output (${keys}) VALUES (${keys.map(() => '?')})`
    ).run(...values);
  }

  function extractInput(record: Record<string, any>) {
    return Object.entries(record).reduce((acc, [key, value]) => {
      if (key === 'id') return { ...acc, id: value };
      const isJson = key.endsWith('_json');
      acc[isJson ? key.slice(0, -5) : key] = isJson ? JSON.parse(value) : value;
      return acc;
    }, {});
  }

  // Signal handlers
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}