import { useCallback, useEffect, useRef } from "react";
import { useCollabStore } from "@/stores/use-collab-store";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata, CanvasNodeStatus } from "@/types/canvas";

export async function uploadAssetToCollabServer(storageKey: string, blob: Blob) {
    if (!storageKey || !blob) return;
    try {
        const encodedKey = encodeURIComponent(storageKey);
        await fetch(`/api/collab/assets/${encodedKey}`, {
            method: "PUT",
            headers: {
                "Content-Type": blob.type || "application/octet-stream",
            },
            body: blob,
        });
    } catch (err) {
        console.warn("[Collab] Failed to upload asset to server:", err);
    }
}

export async function getAnyAssetBlob(storageKey: string, contentUrl?: string): Promise<Blob | null> {
    if (!storageKey && !contentUrl) return null;
    let blob: Blob | null | undefined = null;
    if (storageKey) {
        if (storageKey.startsWith("video:") || storageKey.startsWith("audio:") || storageKey.startsWith("file:")) {
            blob = await getMediaBlob(storageKey);
        } else if (storageKey.startsWith("image:")) {
            blob = await getImageBlob(storageKey);
        }
        if (!blob) blob = await getImageBlob(storageKey);
        if (!blob) blob = await getMediaBlob(storageKey);
    }
    if (!blob && contentUrl && contentUrl.startsWith("blob:")) {
        try {
            const resp = await fetch(contentUrl);
            if (resp.ok) {
                blob = await resp.blob();
            }
        } catch {
            // Ignore fetch failure
        }
    }
    return blob || null;
}

export function toCollabAssetUrl(storageKey: string): string {
    return `/api/collab/assets/${encodeURIComponent(storageKey)}`;
}

export function sanitizeMetadataForCollab(meta: CanvasNodeMetadata): CanvasNodeMetadata {
    let hasChanges = false;
    let newContent = meta.content;

    if (meta.storageKey) {
        if (!meta.content || meta.content.startsWith("blob:")) {
            newContent = toCollabAssetUrl(meta.storageKey);
            hasChanges = true;
        }
    }

    let newImages = meta.images;
    if (meta.images && meta.images.length > 0) {
        newImages = meta.images.map((img) => {
            if (img.storageKey && (!img.content || img.content.startsWith("blob:"))) {
                hasChanges = true;
                return { ...img, content: toCollabAssetUrl(img.storageKey) };
            }
            return img;
        });
    }

    let newGenRefs = meta.generationReferences;
    if (meta.generationReferences && meta.generationReferences.length > 0) {
        newGenRefs = meta.generationReferences.map((ref) => {
            if (ref.storageKey && (!ref.url || ref.url.startsWith("blob:"))) {
                hasChanges = true;
                return { ...ref, url: toCollabAssetUrl(ref.storageKey) };
            }
            return ref;
        });
    }

    if (!hasChanges) return meta;
    return {
        ...meta,
        content: newContent,
        images: newImages,
        generationReferences: newGenRefs,
    };
}

export function sanitizeNodeForCollab(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata) return node;
    const sanitizedMeta = sanitizeMetadataForCollab(node.metadata);
    if (sanitizedMeta === node.metadata) return node;
    return {
        ...node,
        metadata: sanitizedMeta,
    };
}

export async function uploadNodeAssets(node: CanvasNodeData) {
    const meta = node.metadata;
    if (!meta) return;

    if (meta.storageKey) {
        const blob = await getAnyAssetBlob(meta.storageKey, meta.content);
        if (blob) {
            void uploadAssetToCollabServer(meta.storageKey, blob);
        }
    }

    if (meta.images) {
        for (const img of meta.images) {
            if (img.storageKey) {
                const blob = await getAnyAssetBlob(img.storageKey, img.content);
                if (blob) {
                    void uploadAssetToCollabServer(img.storageKey, blob);
                }
            }
        }
    }

    if (meta.generationReferences) {
        for (const ref of meta.generationReferences) {
            if (ref.storageKey) {
                const blob = await getAnyAssetBlob(ref.storageKey, ref.url);
                if (blob) {
                    void uploadAssetToCollabServer(ref.storageKey, blob);
                }
            }
        }
    }
}

export function uploadAllNodesAssets(nodes: CanvasNodeData[]) {
    for (const node of nodes) {
        void uploadNodeAssets(node);
    }
}

export async function ensureCollabAssetCached(storageKey: string, isMedia = false) {
    if (!storageKey) return;
    try {
        if (isMedia || storageKey.startsWith("video:") || storageKey.startsWith("audio:")) {
            const existing = await getMediaBlob(storageKey);
            if (existing) return;
        } else {
            const existing = await getImageBlob(storageKey);
            if (existing) return;
        }
        const encodedKey = encodeURIComponent(storageKey);
        const res = await fetch(`/api/collab/assets/${encodedKey}`);
        if (!res.ok) return;
        const blob = await res.blob();
        if (isMedia || storageKey.startsWith("video:") || storageKey.startsWith("audio:")) {
            await setMediaBlob(storageKey, blob);
        } else {
            await setImageBlob(storageKey, blob);
        }
    } catch (err) {
        console.warn("[Collab] Failed to cache collab asset:", storageKey, err);
    }
}

export function useCanvasCollab({
    onRemoteCanvasUpdate,
    onRemoteNodesPatch,
    onRemoteGenerationStatus,
    getCurrentSnapshot,
}: {
    onRemoteCanvasUpdate?: (nodes: CanvasNodeData[], connections: CanvasConnection[], title?: string) => void;
    onRemoteNodesPatch?: (nodes: CanvasNodeData[], connections: CanvasConnection[]) => void;
    onRemoteGenerationStatus?: (nodeId: string, status: CanvasNodeStatus, errorDetails?: string, metadata?: CanvasNodeMetadata) => void;
    getCurrentSnapshot?: () => { nodes: CanvasNodeData[]; connections: CanvasConnection[]; title: string };
}) {
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const activeRoomId = useCollabStore((s) => s.activeRoomId);
    const role = useCollabStore((s) => s.role);
    const clientId = useCollabStore((s) => s.clientId);
    const hostToken = useCollabStore((s) => s.hostToken);
    const nickname = useCollabStore((s) => s.nickname);
    const myColor = useCollabStore((s) => s.myColor);
    const setStatus = useCollabStore((s) => s.setStatus);
    const setOnlineUsers = useCollabStore((s) => s.setOnlineUsers);
    const updatePeerPresence = useCollabStore((s) => s.updatePeerPresence);
    const setHostOnline = useCollabStore((s) => s.setHostOnline);
    const setLanIp = useCollabStore((s) => s.setLanIp);

    // Fetch local LAN IP on mount
    useEffect(() => {
        fetch("/api/collab/network-ip")
            .then((r) => r.json())
            .then((d) => {
                if (d?.ip && d.ip !== "127.0.0.1") {
                    setLanIp(d.ip);
                }
            })
            .catch(() => {});
    }, [setLanIp]);

    // Send helper
    const send = useCallback((payload: Record<string, unknown>) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(payload));
        }
    }, []);

    // Broadcast canvas sync (Host only)
    const broadcastCanvasSync = useCallback(
        (nodes: CanvasNodeData[], connections: CanvasConnection[], title?: string) => {
            if (role !== "host" || !activeRoomId) return;

            // Upload assets to server
            uploadAllNodesAssets(nodes);

            // Sanitize nodes so blob URLs are replaced with accessible collab asset URLs
            const sharedNodes = nodes.map(sanitizeNodeForCollab);

            send({
                type: "sync_canvas",
                roomId: activeRoomId,
                clientId,
                nodes: sharedNodes,
                connections,
                title,
            });
        },
        [role, activeRoomId, clientId, send],
    );

    // Broadcast patch (Host only)
    const broadcastNodesPatch = useCallback(
        (nodes: CanvasNodeData[], connections: CanvasConnection[]) => {
            if (role !== "host" || !activeRoomId) return;

            uploadAllNodesAssets(nodes);
            const sharedNodes = nodes.map(sanitizeNodeForCollab);

            send({
                type: "patch_nodes",
                roomId: activeRoomId,
                clientId,
                nodes: sharedNodes,
                connections,
            });
        },
        [role, activeRoomId, clientId, send],
    );

    // Broadcast generation status (Host only)
    const broadcastGenerationStatus = useCallback(
        (nodeId: string, status: CanvasNodeStatus, errorDetails?: string, metadata?: CanvasNodeMetadata) => {
            if (role !== "host" || !activeRoomId) return;

            if (metadata?.storageKey) {
                getAnyAssetBlob(metadata.storageKey, metadata.content).then((blob) => {
                    if (blob) void uploadAssetToCollabServer(metadata.storageKey!, blob);
                });
            }

            const sanitizedMeta = metadata ? sanitizeMetadataForCollab(metadata) : undefined;

            send({
                type: "generation_status",
                roomId: activeRoomId,
                clientId,
                nodeId,
                status,
                errorDetails,
                metadata: sanitizedMeta,
            });
        },
        [role, activeRoomId, clientId, send],
    );

    // Broadcast cursor position (All roles)
    const broadcastCursor = useCallback(
        (cursor: { x: number; y: number } | null, selectedNodeIds: string[] = []) => {
            if (!activeRoomId) return;
            send({
                type: "cursor",
                roomId: activeRoomId,
                clientId,
                cursor,
                selectedNodeIds,
            });
        },
        [activeRoomId, clientId, send],
    );

    // Connect & maintain WebSocket
    useEffect(() => {
        if (!activeRoomId) {
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            return;
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/ws/collab`;

        let isUnmounted = false;

        const connect = () => {
            if (isUnmounted) return;
            setStatus("connecting");

            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                if (isUnmounted) return;
                setStatus("connected");
                ws.send(
                    JSON.stringify({
                        type: "join",
                        roomId: activeRoomId,
                        clientId,
                        role,
                        hostToken,
                        nickname,
                        color: myColor,
                    }),
                );

                if (role === "host" && getCurrentSnapshot) {
                    const snap = getCurrentSnapshot();
                    if (snap?.nodes?.length) {
                        broadcastCanvasSync(snap.nodes, snap.connections, snap.title);
                    }
                }
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === "join_ack") {
                        setHostOnline(Boolean(data.isHostOnline));
                        // If viewer and server has a cached snapshot, load it!
                        if (role === "viewer" && data.snapshot?.nodes?.length) {
                            const sanitizedNodes = data.snapshot.nodes.map(sanitizeNodeForCollab);
                            onRemoteCanvasUpdate?.(sanitizedNodes, data.snapshot.connections, data.snapshot.title);
                            // Preload assets in background
                            for (const node of sanitizedNodes) {
                                if (node.metadata?.storageKey) {
                                    void ensureCollabAssetCached(node.metadata.storageKey, node.type === "video" || node.type === "audio");
                                }
                            }
                        }
                    } else if (data.type === "user_list") {
                        setOnlineUsers(data.users || [], data.hostId);
                    } else if (data.type === "request_snapshot") {
                        // Host receives request to send fresh state
                        if (role === "host" && getCurrentSnapshot) {
                            const snapshot = getCurrentSnapshot();
                            broadcastCanvasSync(snapshot.nodes, snapshot.connections, snapshot.title);
                        }
                    } else if (data.type === "canvas_updated") {
                        if (role === "viewer") {
                            const sanitizedNodes = (data.nodes || []).map(sanitizeNodeForCollab);
                            onRemoteCanvasUpdate?.(sanitizedNodes, data.connections || [], data.title);
                            // Preload assets
                            for (const node of sanitizedNodes) {
                                if (node.metadata?.storageKey) {
                                    void ensureCollabAssetCached(node.metadata.storageKey, node.type === "video" || node.type === "audio");
                                }
                            }
                        }
                    } else if (data.type === "nodes_patched") {
                        if (role === "viewer") {
                            const sanitizedNodes = (data.nodes || []).map(sanitizeNodeForCollab);
                            onRemoteNodesPatch?.(sanitizedNodes, data.connections || []);
                            for (const node of sanitizedNodes) {
                                if (node.metadata?.storageKey) {
                                    void ensureCollabAssetCached(node.metadata.storageKey, node.type === "video" || node.type === "audio");
                                }
                            }
                        }
                    } else if (data.type === "node_generation_status") {
                        if (role === "viewer") {
                            const sanitizedMeta = data.metadata ? sanitizeMetadataForCollab(data.metadata) : undefined;
                            onRemoteGenerationStatus?.(data.nodeId, data.status, data.errorDetails, sanitizedMeta);
                            if (sanitizedMeta?.storageKey) {
                                void ensureCollabAssetCached(
                                    sanitizedMeta.storageKey,
                                    sanitizedMeta.generationMode === "video" || sanitizedMeta.generationMode === "audio",
                                );
                            }
                        }
                    } else if (data.type === "cursor_update") {
                        updatePeerPresence({
                            clientId: data.clientId,
                            nickname: data.nickname,
                            color: data.color,
                            cursor: data.cursor,
                            selectedNodeIds: data.selectedNodeIds || [],
                        });
                    } else if (data.type === "host_status") {
                        setHostOnline(Boolean(data.online));
                    }
                } catch (err) {
                    console.error("[Collab] Message parse error:", err);
                }
            };

            ws.onerror = (e) => {
                console.warn("[Collab] WebSocket error:", e);
            };

            ws.onclose = () => {
                if (isUnmounted) return;
                setStatus("disconnected");
                // Try reconnect in 3s
                reconnectTimerRef.current = setTimeout(connect, 3000);
            };
        };

        connect();

        return () => {
            isUnmounted = true;
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [
        activeRoomId,
        role,
        clientId,
        hostToken,
        nickname,
        myColor,
        setStatus,
        setOnlineUsers,
        updatePeerPresence,
        setHostOnline,
        onRemoteCanvasUpdate,
        onRemoteNodesPatch,
        onRemoteGenerationStatus,
        getCurrentSnapshot,
        broadcastCanvasSync,
    ]);

    return {
        broadcastCanvasSync,
        broadcastNodesPatch,
        broadcastGenerationStatus,
        broadcastCursor,
    };
}
