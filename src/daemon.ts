#!/usr/bin/env bun

import { watch } from 'node:fs';
import { join, basename, parse } from 'node:path';
import { Database } from 'bun:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { measure } from './helpers';
import { randomUUID } from "crypto";

const AGENTS_DIR = process.env.SATI_AGENTS_DIR || './agents';
const DB_DIR = process.env.SATI_DB_DIR || join(process.env.HOME || '.', '.mements');
const WS_PORT = parseInt(process.env.WS_PORT || '3333');

const wsConnections = new Map<string, Set<WebSocket>>();
const agentFiles = new Map<string, string>();
const lastChecks = new Map<string, number>();

if (import.meta.main) {
    const requestId = randomUUID().split('-')[0];

    let server: ReturnType<typeof Bun.serve> | undefined;

    measure(async (measure) => {
        server = await measure(async () => {
            return Bun.serve({
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
                                const agentName = data.agent;
                                if (!wsConnections.has(agentName)) {
                                    wsConnections.set(agentName, new Set());
                                }
                                wsConnections.get(agentName)!.add(ws);
                                ws.send(JSON.stringify({ type: 'subscribed', agent: agentName }));
                            }
                        }, "Process WebSocket message");
                    },
                    async open(ws) {
                        await measure(async () => { }, "WebSocket client connected");
                    },
                    async close(ws) {
                        await measure(async () => {
                            for (const clients of wsConnections.values()) {
                                clients.delete(ws);
                            }
                        }, "WebSocket client disconnected");
                    },
                },
            });
        }, "Set up WebSocket server");

        await measure(async (measure) => {
            agentFiles.clear();
            const files = await readdir(AGENTS_DIR);
            for (const file of files) {
                const filePath = join(AGENTS_DIR, file);
                const fileStat = await stat(filePath);

                if (fileStat.isFile() && (file.endsWith('.js') || file.endsWith('.ts'))) {
                    // Use filename without extension as agent name
                    const agentName = parse(file).name;
                    agentFiles.set(agentName, filePath);
                    lastChecks.set(agentName, 0); // Set to 0 to ensure first check runs
                }
            }
        }, "Initial scan agent files");

        // Watch for file changes
        watch(AGENTS_DIR, async (eventType, filename) => {
            console.log('===> daemon.ts:77 ~ eventType', eventType);
            if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.ts'))) return;

            await measure(async (measure) => {
                // Use filename without extension as agent name
                const agentName = parse(filename).name;
                const filePath = join(AGENTS_DIR, filename);

                if (eventType === 'rename') {
                    // Check if file still exists
                    try {
                        await stat(filePath);
                        // File exists, it was created or renamed to
                        agentFiles.set(agentName, filePath);
                        lastChecks.set(agentName, 0); // Set to 0 to ensure check runs
                    } catch (e) {
                        // File doesn't exist, it was deleted or renamed from
                        agentFiles.delete(agentName);
                        lastChecks.delete(agentName);
                    }
                } else {
                    // File was modified, ensure it's in our map
                    agentFiles.set(agentName, filePath);
                    lastChecks.set(agentName, 0); // Set to 0 to ensure check runs 
                }
            }, "Process file change");
        });

        // Periodic check for unprocessed inputs
        setInterval(() => {
            measure(async (measure) => {
                for (const [agentName, agentFile] of agentFiles.entries()) {
                    await measure(async (measure) => {
                        // Throttle checks to avoid excessive database access
                        const now = Date.now();
                        if ((now - (lastChecks.get(agentName) || 0)) < 1000) return;
                        lastChecks.set(agentName, now);

                        // Check for unprocessed inputs
                        const dbPath = join(DB_DIR, 'agents', `${agentName}.sqlite`);

                        try {
                            const db = new Database(dbPath);
                            const unprocessedInputs = db.query(`
                                SELECT i.id
                                FROM input i
                                LEFT JOIN output o ON i.id = o.id
                                WHERE o.id IS NULL
                                ORDER BY i.id ASC
                                LIMIT 5
                            `).all();

                            if (unprocessedInputs.length > 0) {
                                for (const row of unprocessedInputs) {
                                    await measure(async () => {
                                        const id = row.id;

                                        // Spawn process to handle the input
                                        const newProcess = Bun.spawn({
                                            cmd: ["bun", "run", agentFile, id],
                                            env: { ...process.env, SATI_INPUT_ID: id },
                                            stdout: 'pipe',
                                            stderr: 'pipe'
                                        });

                                        // Get process output
                                        const output = await new Response(newProcess.stdout).text();
                                        const errors = await new Response(newProcess.stderr).text();

                                        if (errors) {
                                            console.error(`Error processing input ${id} for ${agentName}:`, errors);
                                            return;
                                        }

                                        // Try to parse output
                                        try {
                                            const outputData = JSON.parse(output);

                                            if (outputData.id) {
                                                // Broadcast to all connected clients
                                                const clients = wsConnections.get(agentName);
                                                if (clients?.size > 0) {
                                                    const message = JSON.stringify({
                                                        type: 'update',
                                                        agent: agentName,
                                                        data: { id: outputData.id, input_id: id }
                                                    });

                                                    for (const client of clients) {
                                                        if (client.readyState === Bun.WebSocket.OPEN) {
                                                            client.send(message);
                                                        }
                                                    }
                                                }
                                            }
                                        } catch (parseError) {
                                            console.error(`Error parsing output for ${agentName}:`, parseError);
                                            console.log("Raw output:", output);
                                        }
                                    }, `Process input ${row.id} for ${agentName}`);
                                }
                            }
                        } catch (dbError) {
                            if (String(dbError).includes('no such file or directory')) {
                                // Skip this check, database doesn't exist yet
                            } else if (String(dbError).includes('unable to open database file')) {
                                console.log('agent not file yet thats fine')
                            } else {
                                console.error(`Unexpected error for ${agentName}:`, dbError);
                            }
                        }
                    }, `Check inputs for ${agentName}`);
                }
            }, "Check all agents");
        }, 2000);
    }, "Run agents in " + AGENTS_DIR, { requestId }).catch(error => {
        console.error("Failed to start daemon:", error);
        process.exit(1);
    });

    // Shutdown handlers
    process.on('SIGINT', () => {
        measure(async () => {
            if (server) server.stop();
            console.log("sati-daemon stopped via SIGINT");
            process.exit(0);
        }, "Shutdown daemon (SIGINT)");
    });

    process.on('SIGTERM', () => {
        measure(async () => {
            if (server) server.stop();
            console.log("sati-daemon stopped via SIGTERM");
            process.exit(0);
        }, "Shutdown daemon (SIGTERM)");
    });
}