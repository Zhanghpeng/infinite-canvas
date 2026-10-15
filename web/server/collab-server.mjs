import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";

// In-memory rooms cache
// roomId -> { id, hostId, hostToken, title, nodes: [], connections: [], clients: Map<clientId, Client> }
const rooms = new Map();

// In-memory assets cache for LAN sharing: storageKey -> { buffer, mimeType }
const assetsCache = new Map();

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

// Middleware for express / connect / Vite dev server
export function collabHttpMiddleware(req, res, next) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/api/collab/network-ip") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ip: getLocalIpAddress() }));
        return;
    }

    if (url.pathname.startsWith("/api/collab/assets/")) {
        const key = decodeURIComponent(url.pathname.replace("/api/collab/assets/", ""));
        if (req.method === "GET") {
            const asset = assetsCache.get(key);
            if (!asset) {
                res.statusCode = 404;
                res.end("Asset not found");
                return;
            }
            res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.end(asset.buffer);
            return;
        }

        if (req.method === "PUT" || req.method === "POST") {
            const chunks = [];
            req.on("data", (chunk) => chunks.push(chunk));
            req.on("end", () => {
                const buffer = Buffer.concat(chunks);
                const mimeType = req.headers["content-type"] || "application/octet-stream";
                assetsCache.set(key, { buffer, mimeType });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ success: true, key, size: buffer.length }));
            });
            return;
        }
    }

    if (typeof next === "function") next();
}
