#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { Server } from "bun";
import { WebSocketServer } from "ws";
import * as sqliteVec from "sqlite-vec";
import * as path from "path";
import { mkdir } from "node:fs/promises";
import { verboseLog, measure } from "./helpers";
import { Agent } from "./sati";
import { z } from "zod";
import { dezerialize, zerialize } from "zodex";

// Configuration constants
const POLLING_INTERVAL = 1000; // milliseconds
const DEFAULT_PORT = 3333;

interface AgentRecord {
  name: string;
  from_schema: string;
  to_schema: string;
  input_table: string;
  output_table: string;
}

// Track active connections by agent name
const connections: Map<string, Set<WebSocket>> = new Map();
// Track active polling for each agent
const activePolling: Map<string, { timer: any; lastProcessedId?: string }> = new Map();

// Initialize database connection
let db: Database;
{
  const dirname = process.env.HOME ? path.join(process.env.HOME, ".mements") : ".";
  const dbPath = path.join(
    dirname,
    `${process.env.SATI_DB_NAME ?? "sati"}.sqlite`,
  );
  
  verboseLog("Database", "Initializing", { path: dbPath });
  
  await mkdir(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  
  sqliteVec.load(db);
}

// Main SatiServer class
class SatiServer {
  private wss: WebSocketServer;
  private httpServer: Server;
  private port: number;
  private agentInstances: Map<string, any> = new Map();

  constructor(port: number = DEFAULT_PORT) {
    this.port = port;
    this.httpServer = Bun.serve({
      port: this.port,
      fetch: this.handleHttpRequest.bind(this),
    });

    // Setup WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', this.handleWsConnection.bind(this));

    this.loadAgents();

    verboseLog("Server", "Started", { port: this.port });
  }

  private async loadAgents() {
    const agents = db.query<AgentRecord, any>("SELECT * FROM agents").all();
    
    verboseLog("Server", "Loading agents", { count: agents.length });
    
    for (const agent of agents) {
      await this.startAgentPolling(agent);
    }
  }

  private async startAgentPolling(agentRecord: AgentRecord) {
    const { name, from_schema, to_schema, input_table, output_table } = agentRecord;
    
    verboseLog("Polling", "Starting for agent", { name });
    
    const fromSchema = dezerialize(JSON.parse(from_schema)) as z.ZodObject<any>;
    const toSchema = dezerialize(JSON.parse(to_schema)) as z.ZodObject<any>;
    
    // Initialize the agent
    const agent = Agent(name);
    this.agentInstances.set(name, agent);
    
    // Start polling for new entries
    if (!activePolling.has(name)) {
      const pollingState = {
        timer: setInterval(() => this.pollForNewEntries(name, input_table, output_table, fromSchema, toSchema), 
          POLLING_INTERVAL)
      };
      
      activePolling.set(name, pollingState);
      connections.set(name, new Set());
      
      verboseLog("Polling", "Initialized for agent", { name });
    }
  }

  private async pollForNewEntries(
    agentName: string,
    inputTable: string,
    outputTable: string,
    fromSchema: z.ZodObject<any>,
    toSchema: z.ZodObject<any>
  ) {
    return measure(
      async () => {
        const pollingState = activePolling.get(agentName);
        if (!pollingState) return;
        
        const lastProcessedId = pollingState.lastProcessedId;
        
        // Find unprocessed inputs (where output rows don't exist or are empty)
        let query = `
          SELECT i.*
          FROM ${inputTable} i
          LEFT JOIN ${outputTable} o ON i.id = o.id
          WHERE o.id IS NULL
        `;
        
        const params: any[] = [];
        if (lastProcessedId) {
          query += ` AND i.id > ?`;
          params.push(lastProcessedId);
        }
        
        query += ` ORDER BY i.id ASC LIMIT 5`;
        
        const unprocessedInputs = db.query(query).all(...params);
        
        if (unprocessedInputs.length === 0) return;
        
        verboseLog("Polling", "Found unprocessed inputs", { 
          agent: agentName, 
          count: unprocessedInputs.length 
        });
        
        // Process each input
        for (const row of unprocessedInputs) {
          // Process fields (convert JSON fields back to objects)
          const processedInput = this.processFields(row, fromSchema);
          
          try {
            const agent = this.agentInstances.get(agentName);
            
            // Infer output using the agent
            const output = await agent.infer(processedInput);
            
            // Store the output (using store which will insert into output table)
            await agent.reinforce(processedInput, output);
            
            // Notify connected clients
            this.broadcastUpdate(agentName, { 
              id: row.id, 
              input: processedInput, 
              output 
            });
            
            // Update last processed ID
            pollingState.lastProcessedId = row.id;
            
            verboseLog("Polling", "Processed input", { 
              agent: agentName, 
              id: row.id 
            });
          } catch (error) {
            verboseLog("Polling", "Error processing input", { 
              agent: agentName, 
              id: row.id, 
              error 
            });
          }
        }
      },
      "Server",
      `Polling for agent ${agentName}`
    );
  }

  private processFields(data: Record<string, any>, schema: z.ZodObject<any>): any {
    const processed: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(data)) {
      if (key === "id") {
        processed[key] = value;
        continue;
      }
      
      if (key.endsWith("_json")) {
        const baseKey = key.slice(0, -5);
        try {
          processed[baseKey] = JSON.parse(value as string);
        } catch {
          processed[baseKey] = value;
        }
      } else {
        processed[key] = value;
      }
    }
    
    return schema.parse(processed);
  }

  private broadcastUpdate(agentName: string, data: any) {
    const clientSet = connections.get(agentName);
    if (!clientSet) return;
    
    const message = JSON.stringify({
      type: 'update',
      agent: agentName,
      data
    });
    
    verboseLog("WebSocket", "Broadcasting update", { 
      agent: agentName, 
      clients: clientSet.size 
    });
    
    for (const client of clientSet) {
      try {
        client.send(message);
      } catch (error) {
        verboseLog("WebSocket", "Error sending message", { error });
      }
    }
  }

  private async handleWsConnection(ws: WebSocket) {
    verboseLog("WebSocket", "New connection");
    
    // Setup message handler for subscription requests
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data as string);
        
        if (message.type === 'subscribe' && message.agent) {
          const agentName = message.agent;
          
          // Add to connections for this agent
          if (!connections.has(agentName)) {
            connections.set(agentName, new Set());
          }
          
          connections.get(agentName)!.add(ws);
          
          verboseLog("WebSocket", "Client subscribed", { agent: agentName });
          
          // Acknowledge the subscription
          ws.send(JSON.stringify({
            type: 'subscribed',
            agent: agentName
          }));
        }
      } catch (error) {
        verboseLog("WebSocket", "Error processing message", { error });
      }
    });
    
    // Handle disconnection
    ws.addEventListener('close', () => {
      verboseLog("WebSocket", "Connection closed");
      
      // Remove from all agent connections
      for (const [agent, clients] of connections.entries()) {
        if (clients.has(ws)) {
          clients.delete(ws);
          verboseLog("WebSocket", "Client unsubscribed", { agent });
        }
      }
    });
  }

  private async handleHttpRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    
    // API endpoint to get active agents
    if (url.pathname === '/agents' && req.method === 'GET') {
      const agents = db.query<AgentRecord, { name: string }>("SELECT name FROM agents").all();
      return new Response(
        JSON.stringify({ agents: agents.map(a => a.name) }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // API endpoint to check status
    if (url.pathname === '/status' && req.method === 'GET') {
      return new Response(
        JSON.stringify({ 
          status: 'ok',
          agents: Array.from(this.agentInstances.keys()),
          connections: Object.fromEntries(
            Array.from(connections.entries()).map(([k, v]) => [k, v.size])
          )
        }), 
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
    
    // Fallback for unmatched routes
    return new Response('Not Found', { status: 404 });
  }

  public stop() {
    // Clear all polling intervals
    for (const [name, { timer }] of activePolling.entries()) {
      clearInterval(timer);
      verboseLog("Polling", "Stopped for agent", { name });
    }
    
    activePolling.clear();
    
    // Close all WebSocket connections
    for (const clients of connections.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    
    connections.clear();
    
    // Stop HTTP server
    this.httpServer.stop(true);
    
    verboseLog("Server", "Stopped");
  }
}

// CLI handler
if (import.meta.main) {
  const port = process.env.PORT ? parseInt(process.env.PORT) : DEFAULT_PORT;
  const server = new SatiServer(port);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    verboseLog("Process", "Received SIGINT, shutting down");
    server.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    verboseLog("Process", "Received SIGTERM, shutting down");
    server.stop();
    process.exit(0);
  });
}

export { SatiServer };
