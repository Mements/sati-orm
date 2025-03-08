#!/usr/bin/env bun

import { watch } from 'node:fs';
import { join, basename } from 'node:path';
import { Database } from 'bun:sqlite';
import { readdir, stat } from 'node:fs/promises';
import { measure } from './helpers';

const AGENTS_DIR = process.env.SATI_AGENTS_DIR || './agents';
const DB_DIR = process.env.SATI_DB_DIR || join(process.env.HOME || '.', '.mements');
const WS_PORT = parseInt(process.env.WS_PORT || '3333');

const wsConnections = new Map<string, Set<Bun.WebSocket>>();
const agentsByDb = new Map<string, string>();
const lastChecks = new Map<string, number>();

if (import.meta.main) {
    let server: ReturnType<typeof Bun.serve> | undefined;

    measure(async (measure) => {
        console.log(`Starting sati-daemon watcher in ${AGENTS_DIR}`);

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
                        await measure(async () => {}, "WebSocket client connected");
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
            agentsByDb.clear();
            const files = await readdir(AGENTS_DIR);
            for (const file of files) {
                const filePath = join(AGENTS_DIR, file);
                const fileStat = await stat(filePath);
                if (fileStat.isFile() && (file.endsWith('.js') || file.endsWith('.ts'))) {
                    await measure(async () => {
                        const agent = await import(filePath);
                        if (agent.dbName) {
                            agentsByDb.set(agent.dbName, filePath);
                            lastChecks.set(agent.dbName, Date.now());
                            await measure(async (measure) => {
                                const dbName = agent.dbName;
                                const now = Date.now();
                                if ((now - (lastChecks.get(dbName) || 0)) < 1000) return;
                                lastChecks.set(dbName, now);

                                const dbPath = join(DB_DIR, 'agents', `${dbName}.sqlite`);
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
                                            const newProcess = Bun.spawn({
                                                cmd: ["bun", "run", filePath, id],
                                                env: { ...process.env, SATI_INPUT_ID: id },
                                                stdout: 'pipe',
                                                stderr: 'pipe'
                                            });
                                            const output = await new Response(newProcess.stdout).text();
                                            const errors = await new Response(newProcess.stderr).text();
                                            if (errors) throw new Error(errors);
                                            const outputData = JSON.parse(output);
                                            if (outputData.id) {
                                                const clients = wsConnections.get(dbName);
                                                if (clients?.size > 0) {
                                                    const message = JSON.stringify({
                                                        type: 'update',
                                                        agent: dbName,
                                                        data: { id: outputData.id, input_id: id }
                                                    });
                                                    for (const client of clients) {
                                                        if (client.readyState === WebSocket.OPEN) {
                                                            client.send(message);
                                                        }
                                                    }
                                                }
                                            }
                                        }, `Process input ${row.id} for ${dbName}`);
                                    }
                                }
                            }, `Initial check inputs for ${agent.dbName}`);
                        }
                    }, `Load agent ${file}`);
                }
            }
        }, "Initial scan agent files");

        watch(AGENTS_DIR, async (eventType, filename) => {
            if (!filename || (!filename.endsWith('.js') && !filename.endsWith('.ts'))) return;
            await measure(async (measure) => {
                agentsByDb.clear();
                const files = await readdir(AGENTS_DIR);
                for (const file of files) {
                    const filePath = join(AGENTS_DIR, file);
                    const fileStat = await stat(filePath);
                    if (fileStat.isFile() && (file.endsWith('.js') || file.endsWith('.ts'))) {
                        await measure(async () => {
                            const agent = await import(filePath);
                            if (agent.dbName) {
                                agentsByDb.set(agent.dbName, filePath);
                                lastChecks.set(agent.dbName, Date.now());
                            }
                        }, `Reload agent ${file}`);
                    }
                }
            }, "Rescan agent files due to change");
        });

        setInterval(() => {
            measure(async (measure) => {
                for (const [dbName, agentFile] of agentsByDb.entries()) {
                    await measure(async (measure) => {
                        const now = Date.now();
                        if ((now - (lastChecks.get(dbName) || 0)) < 1000) return;
                        lastChecks.set(dbName, now);

                        const dbPath = join(DB_DIR, 'agents', `${dbName}.sqlite`);
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
                                    const newProcess = Bun.spawn({
                                        cmd: ["bun", "run", agentFile, id],
                                        env: { ...process.env, SATI_INPUT_ID: id },
                                        stdout: 'pipe',
                                        stderr: 'pipe'
                                    });
                                    const output = await new Response(newProcess.stdout).text();
                                    const errors = await new Response(newProcess.stderr).text();
                                    if (errors) throw new Error(errors);
                                    const outputData = JSON.parse(output);
                                    if (outputData.id) {
                                        const clients = wsConnections.get(dbName);
                                        if (clients?.size > 0) {
                                            const message = JSON.stringify({
                                                type: 'update',
                                                agent: dbName,
                                                data: { id: outputData.id, input_id: id }
                                            });
                                            for (const client of clients) {
                                                if (client.readyState === Bun.WebSocket.OPEN) {
                                                    client.send(message);
                                                }
                                            }
                                        }
                                    }
                                }, `Process input ${row.id} for ${dbName}`);
                            }
                        }
                    }, `Periodic check inputs for ${dbName}`);
                }
            }, "Periodic check all databases");
        }, 2000);

        console.log(`sati-daemon running, WebSocket server on port ${WS_PORT}`);

    }, "Run sati-daemon").catch(error => {
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