/**
 * Helper utilities for agent files
 * This provides a standardized way to handle agent processing
 */

import { Agent } from '../sati';
import { z } from 'zod';
import WebSocket from 'ws';

// Store active WebSocket connections
const wsConnections = new Map<string, {
  ws: WebSocket | null,
  callbacks: Map<string, (data: any) => void>
}>();

/**
 * Process an input record with the given agent and processing function
 * This is used in the command-line mode when spawned by the daemon
 */
export async function processInput<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  dbName: string,
  inputSchema: I,
  outputSchema: O,
  processFn: (input: z.infer<I>) => Promise<z.infer<O>>
): Promise<{ id: string }> {
  // Initialize agent
  const agent = Agent(dbName).init(inputSchema, outputSchema, { inferenceEngine: 'none' });
  
  // Get the input ID from arguments or environment
  const inputId = process.argv[2] || process.env.SATI_INPUT_ID;
  
  if (!inputId) {
    throw new Error("No input ID provided");
  }
  
  try {
    // Find the input record
    const records = await agent.find({ id: inputId });
    
    if (records.length === 0) {
      throw new Error(`Input record ${inputId} not found`);
    }
    
    const input = records[0].input;
    
    // Process the input
    const output = await processFn(input);
    
    // Update the output record
    await agent.edit(inputId, {}, output);
    
    // Return the ID
    return { id: inputId };
  } catch (error) {
    console.error(`Error processing input ${inputId}:`, error);
    throw error;
  }
}

/**
 * Enhanced insert function that waits for the result
 * This can be used client-side to insert and wait for processing
 */
export async function insertAndWait<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  agent: any,
  input: z.infer<I>,
  options: {
    timeout?: number;
    serverUrl?: string;
  } = {}
): Promise<{ id: string; output: z.infer<O> }> {
  // Default options
  const timeout = options.timeout || 60000; // 1 minute default
  const serverUrl = options.serverUrl || 
                   process.env.SATI_SERVER_URL || 
                   'ws://localhost:3333';
  
  // First, insert the input
  const { id } = await agent.insert(input);
  
  // Now wait for the output
  return new Promise((resolve, reject) => {
    // Set timeout
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to input ${id}`));
    }, timeout);
    
    // Function to handle the response
    const handleResponse = (data: any) => {
      if (data.id === id || data.input_id === id) {
        // We got our response
        clearTimeout(timeoutId);
        
        // Get the complete record
        agent.find({ id: data.id || data.input_id })
          .then((records: any[]) => {
            if (records.length > 0) {
              resolve({
                id: records[0].id,
                output: records[0].output
              });
            } else {
              reject(new Error(`Could not find output record for ${id}`));
            }
          })
          .catch(reject);
        
        // Clean up
        const connection = wsConnections.get(agent.name);
        if (connection) {
          connection.callbacks.delete(id);
        }
      }
    };
    
    // Set up WebSocket connection
    setupWebSocket(agent.name, serverUrl, id, handleResponse)
      .catch(reject);
  });
}

/**
 * Set up WebSocket connection for an agent
 */
async function setupWebSocket(
  agentName: string,
  serverUrl: string,
  id: string,
  callback: (data: any) => void
): Promise<void> {
  // Initialize connection if needed
  if (!wsConnections.has(agentName)) {
    wsConnections.set(agentName, {
      ws: null,
      callbacks: new Map()
    });
  }
  
  const connection = wsConnections.get(agentName)!;
  
  // Store callback
  connection.callbacks.set(id, callback);
  
  // Return if already connected
  if (connection.ws && connection.ws.readyState === WebSocket.OPEN) {
    return;
  }
  
  // Connect to WebSocket server
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    connection.ws = ws;
    
    ws.onopen = () => {
      // Subscribe to updates for this agent
      ws.send(JSON.stringify({
        type: 'subscribe',
        agent: agentName
      }));
      
      resolve();
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        
        if (message.type === 'update' && message.agent === agentName) {
          // Call all relevant callbacks
          for (const [callbackId, cb] of connection.callbacks.entries()) {
            cb(message.data);
          }
        }
      } catch (error) {
        console.error("Error handling WebSocket message:", error);
      }
    };
    
    ws.onerror = (error) => {
      reject(error);
    };
    
    ws.onclose = () => {
      connection.ws = null;
    };
  });
}

/**
 * Create the main handler for an agent file
 * This handles both being imported by other code and being run directly
 */
export function createAgentHandler<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  dbName: string,
  inputSchema: I,
  outputSchema: O,
  processFn: (input: z.infer<I>) => Promise<z.infer<O>>
) {
  // Create the main handler
  const handler = async () => {
    try {
      const result = await processInput(dbName, inputSchema, outputSchema, processFn);
      // Output as JSON for the daemon to parse
      console.log(JSON.stringify(result));
      return result;
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  
  // Run the handler if this is the main module
  if (import.meta.main) {
    handler();
  }
  
  // Export the components
  return {
    dbName,
    inputSchema,
    outputSchema,
    process: processFn,
    handler
  };
}
