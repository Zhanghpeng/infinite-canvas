import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheDir = resolve(__dirname, "../.collab-cache");
try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
} catch {}

function safeFileName(key) {
    return encodeURIComponent(key).replace(/[*?:/]/g, "_");
}

function saveAssetToDisk(key, buffer, mimeType) {
    try {
        const base = resolve(cacheDir, safeFileName(key));
        writeFileSync(`${base}.bin`, buffer);
        writeFileSync(`${base}.meta.json`, JSON.stringify({ mimeType }));
    } catch (e) {
        console.warn("[CollabServer] Failed to write asset to disk cache:", e);
    }
}

function loadAssetFromDisk(key) {
    try {
        const base = resolve(cacheDir, safeFileName(key));
        const binPath = `${base}.bin`;
        const metaPath = `${base}.meta.json`;
        if (existsSync(binPath) && existsSync(metaPath)) {
            const buffer = readFileSync(binPath);
            const { mimeType } = JSON.parse(readFileSync(metaPath, "utf-8"));
            return { buffer, mimeType };
        }
    } catch (e) {
        console.warn("[CollabServer] Failed to load asset from disk cache:", e);
    }
    return null;
}

// In-memory rooms cache
// roomId -> { id, hostId, hostToken, title, nodes: [], connections: [], clients: Map<clientId, Client> }
const rooms = new Map();

// In-memory assets cache for LAN sharing: storageKey -> { buffer, mimeType }
const assetsCache = new Map();

// Pending waiters for assets currently uploading: storageKey -> Array<callback>
const pendingAssetWaiters = new Map();

export function getLocalIpAddress() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            const familyV4Value = typeof net.family === "string" ? "IPv4" : 4;
            if (net.family === familyV4Value && !net.internal) {
                return net.address;
            }
        }
    }
    return "127.0.0.1";
}

export function attachCollabServer(httpServer) {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (url.pathname === "/ws/collab") {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit("connection", ws, request);
            });
        }
    });

    wss.on("connection", (ws, request) => {
        let currentRoomId = null;
        let currentClientId = null;
        let isHost = false;

        ws.on("message", (raw) => {
            try {
                const message = JSON.parse(raw.toString());
                handleMessage(ws, message, (roomId, clientId, hostStatus) => {
                    currentRoomId = roomId;
                    currentClientId = clientId;
                    isHost = hostStatus;
                });
            } catch (err) {
                console.error("[CollabServer] Failed to handle message:", err);
            }
        });

        ws.on("close", () => {
            if (currentRoomId && currentClientId) {
                const room = rooms.get(currentRoomId);
                if (room) {
                    room.clients.delete(currentClientId);
                    if (isHost && room.hostId === currentClientId) {
                        broadcastToRoom(room, {
                            type: "host_status",
                            online: false,
                        });
                    }
                    broadcastUserList(room);
                    if (room.clients.size === 0) {
                        // Keep room in memory for a while so reloads don't lose data
                        setTimeout(() => {
                            if (room.clients.size === 0) {
                                rooms.delete(currentRoomId);
                            }
                        }, 1000 * 60 * 30); // 30 mins
                    }
                }
            }
        });
    });

    return wss;
}

function handleMessage(ws, msg, setSession) {
    const { type, roomId, clientId } = msg;
    if (!roomId || !clientId) return;

    let room = rooms.get(roomId);
    if (!room) {
        room = {
            id: roomId,
            hostId: null,
            hostToken: null,
            title: "",
            nodes: [],
            connections: [],
            clients: new Map(),
            lastUpdated: Date.now(),
        };
        rooms.set(roomId, room);
    }

    if (type === "join") {
        const role = msg.role === "host" ? "host" : "viewer";
        let isHost = false;

        if (role === "host") {
            if (!room.hostId || !room.hostToken || room.hostToken === msg.hostToken) {
                room.hostId = clientId;
                room.hostToken = msg.hostToken || `token-${Date.now()}`;
                isHost = true;
            } else {
                // If token mismatch, downgrade to viewer
                isHost = false;
            }
        }

        const client = {
            id: clientId,
            ws,
            role: isHost ? "host" : "viewer",
            nickname: msg.nickname || (isHost ? "房主" : `访客_${clientId.slice(-4)}`),
            color: msg.color || (isHost ? "#2563eb" : "#10b981"),
            cursor: null,
            selectedNodeIds: [],
        };

        room.clients.set(clientId, client);
        setSession(roomId, clientId, isHost);

        // Acknowledge join
        send(ws, {
            type: "join_ack",
            roomId,
            clientId,
            role: client.role,
            hostToken: isHost ? room.hostToken : undefined,
            isHostOnline: Boolean(room.hostId && room.clients.has(room.hostId)),
            snapshot: {
                nodes: room.nodes,
                connections: room.connections,
                title: room.title,
            },
        });

        // Broadcast user list
        broadcastUserList(room);

        // Notify host that a viewer joined, requesting fresh snapshot if needed
        if (!isHost && room.hostId && room.clients.has(room.hostId)) {
            const hostClient = room.clients.get(room.hostId);
            send(hostClient.ws, {
                type: "request_snapshot",
                requesterId: clientId,
            });
        }
        return;
    }

    const client = room.clients.get(clientId);
    if (!client) return;

    // Actions restricted to HOST only
    if (type === "sync_canvas") {
        if (client.role !== "host") return; // Unauthorized
        room.nodes = Array.isArray(msg.nodes) ? msg.nodes : room.nodes;
        room.connections = Array.isArray(msg.connections) ? msg.connections : room.connections;
        if (msg.title) room.title = msg.title;
        room.lastUpdated = Date.now();

        // Broadcast to all viewers
        broadcastToRoom(
            room,
            {
                type: "canvas_updated",
                nodes: room.nodes,
                connections: room.connections,
                title: room.title,
            },
            clientId,
        );
        return;
    }

    if (type === "patch_nodes") {
        if (client.role !== "host") return;
        if (Array.isArray(msg.nodes)) {
            room.nodes = msg.nodes;
        }
        if (Array.isArray(msg.connections)) {
            room.connections = msg.connections;
        }
        room.lastUpdated = Date.now();

        broadcastToRoom(
            room,
            {
                type: "nodes_patched",
                nodes: room.nodes,
                connections: room.connections,
            },
            clientId,
        );
        return;
    }

    if (type === "generation_status") {
        if (client.role !== "host") return;
        broadcastToRoom(
            room,
            {
                type: "node_generation_status",
                nodeId: msg.nodeId,
                status: msg.status,
                errorDetails: msg.errorDetails,
                metadata: msg.metadata,
            },
            clientId,
        );
        return;
    }

    // Actions allowed for all (Host and Viewers)
    if (type === "cursor") {
        client.cursor = msg.cursor || null;
        client.selectedNodeIds = Array.isArray(msg.selectedNodeIds) ? msg.selectedNodeIds : [];
        broadcastToRoom(
            room,
            {
                type: "cursor_update",
                clientId,
                nickname: client.nickname,
                color: client.color,
                cursor: client.cursor,
                selectedNodeIds: client.selectedNodeIds,
            },
            clientId,
        );
        return;
    }
}

function broadcastUserList(room) {
    const users = Array.from(room.clients.values()).map((c) => ({
        id: c.id,
        role: c.role,
        nickname: c.nickname,
        color: c.color,
    }));
    broadcastToRoom(room, {
        type: "user_list",
        users,
        hostId: room.hostId,
    });
}

function broadcastToRoom(room, payload, excludeClientId = null) {
    const raw = JSON.stringify(payload);
    for (const client of room.clients.values()) {
        if (excludeClientId && client.id === excludeClientId) continue;
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(raw);
        }
    }
}

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function serveAsset(res, req, asset) {
    const total = asset.buffer.length;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

        if (isNaN(start) || isNaN(end) || start >= total || end >= total || start > end) {
            res.writeHead(416, {
                "Content-Range": `bytes */${total}`,
                "Access-Control-Allow-Origin": "*",
            });
            res.end();
            return;
        }

        const chunk = asset.buffer.subarray(start, end + 1);
        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunk.length,
            "Content-Type": asset.mimeType || "application/octet-stream",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=86400",
        });
        res.end(chunk);
    } else {
        res.writeHead(200, {
            "Content-Length": total,
            "Accept-Ranges": "bytes",
            "Content-Type": asset.mimeType || "application/octet-stream",
            "Cache-Control": "public, max-age=86400",
            "Access-Control-Allow-Origin": "*",
        });
        res.end(asset.buffer);
    }
}

// Middleware for express / connect / Vite dev server
export function collabHttpMiddleware(req, res, next) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/collab/network-ip") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify({ ip: getLocalIpAddress() }));
        return;
    }

    if (url.pathname.startsWith("/api/collab/assets/")) {
        const key = decodeURIComponent(url.pathname.replace("/api/collab/assets/", ""));

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            });
            res.end();
            return;
        }

        if (req.method === "GET") {
            let asset = assetsCache.get(key);
            if (!asset) {
                asset = loadAssetFromDisk(key);
                if (asset) {
                    assetsCache.set(key, asset);
                }
            }

            if (asset) {
                serveAsset(res, req, asset);
                return;
            }

            // Asset not available immediately; wait up to 10s for upload to finish
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                res.statusCode = 404;
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.end("Asset not found");
            }, 10000);

            const onArrived = (arrivedAsset) => {
                if (settled) return;
                settled = true;
                cleanup();
                serveAsset(res, req, arrivedAsset);
            };

            const cleanup = () => {
                clearTimeout(timer);
                const list = pendingAssetWaiters.get(key) || [];
                const idx = list.indexOf(onArrived);
                if (idx !== -1) list.splice(idx, 1);
                if (list.length === 0) pendingAssetWaiters.delete(key);
            };

            const list = pendingAssetWaiters.get(key) || [];
            list.push(onArrived);
            pendingAssetWaiters.set(key, list);
            return;
        }

        if (req.method === "PUT" || req.method === "POST") {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                const buffer = Buffer.concat(chunks);
                const mimeType = req.headers["content-type"] || "application/octet-stream";
                const asset = { buffer, mimeType };
                assetsCache.set(key, asset);
                saveAssetToDisk(key, buffer, mimeType);

                // Notify any pending GET requests waiting for this asset
                const waiters = pendingAssetWaiters.get(key);
                if (waiters && waiters.length > 0) {
                    pendingAssetWaiters.delete(key);
                    for (const waiter of waiters) {
                        try {
                            waiter(asset);
                        } catch {}
                    }
                }

                res.setHeader("Content-Type", "application/json");
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.end(JSON.stringify({ success: true, key, size: buffer.length }));
            });
            return;
        }
    }

    if (typeof next === "function") next();
}
