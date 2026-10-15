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

    // Keep callback props in refs to avoid reconnection loops
    const onRemoteCanvasUpdateRef = useRef(onRemoteCanvasUpdate);
    onRemoteCanvasUpdateRef.current = onRemoteCanvasUpdate;

    const onRemoteNodesPatchRef = useRef(onRemoteNodesPatch);
    onRemoteNodesPatchRef.current = onRemoteNodesPatch;

    const onRemoteGenerationStatusRef = useRef(onRemoteGenerationStatus);
    onRemoteGenerationStatusRef.current = onRemoteGenerationStatus;

    const getCurrentSnapshotRef = useRef(getCurrentSnapshot);
    getCurrentSnapshotRef.current = getCurrentSnapshot;

    const activeRoomId = useCollabStore((s) => s.activeRoomId);
    const role = useCollabStore((s) => s.role);
    const hostToken = useCollabStore((s) => s.hostToken);
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
            const state = useCollabStore.getState();
            if (state.role !== "host" || !state.activeRoomId) return;

            // Upload assets to server
            uploadAllNodesAssets(nodes);

            // Sanitize nodes so blob URLs are replaced with accessible collab asset URLs
            const sharedNodes = nodes.map(sanitizeNodeForCollab);

            send({
                type: "sync_canvas",
                roomId: state.activeRoomId,
                clientId: state.clientId,
                nodes: sharedNodes,
                connections,
                title,
            });
        },
        [send],
    );

    // Broadcast patch (Host only)
    const broadcastNodesPatch = useCallback(
        (nodes: CanvasNodeData[], connections: CanvasConnection[]) => {
            const state = useCollabStore.getState();
            if (state.role !== "host" || !state.activeRoomId) return;

            uploadAllNodesAssets(nodes);
            const sharedNodes = nodes.map(sanitizeNodeForCollab);

            send({
                type: "patch_nodes",
                roomId: state.activeRoomId,
                clientId: state.clientId,
                nodes: sharedNodes,
                connections,
            });
        },
        [send],
    );

    // Broadcast generation status (Host only)
    const broadcastGenerationStatus = useCallback(
        (nodeId: string, status: CanvasNodeStatus, errorDetails?: string, metadata?: CanvasNodeMetadata) => {
            const state = useCollabStore.getState();
            if (state.role !== "host" || !state.activeRoomId) return;

            if (metadata?.storageKey) {
                getAnyAssetBlob(metadata.storageKey, metadata.content).then((blob) => {
                    if (blob) void uploadAssetToCollabServer(metadata.storageKey!, blob);
                });
            }

            const sanitizedMeta = metadata ? sanitizeMetadataForCollab(metadata) : undefined;

            send({
                type: "generation_status",
                roomId: state.activeRoomId,
                clientId: state.clientId,
                nodeId,
                status,
                errorDetails,
                metadata: sanitizedMeta,
            });
        },
        [send],
    );

    // Broadcast cursor position (All roles)
    const broadcastCursor = useCallback(
        (cursor: { x: number; y: number } | null, selectedNodeIds: string[] = []) => {
            const state = useCollabStore.getState();
            if (!state.activeRoomId) return;
            send({
                type: "cursor",
                roomId: state.activeRoomId,
                clientId: state.clientId,
                cursor,
                selectedNodeIds,
            });
        },
        [send],
    );

    // Connect & maintain WebSocket
    useEffect(() => {
        if (!activeRoomId) {
            if (wsRef.current) {
                wsRef.current.close(1000, "leave");
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
                const state = useCollabStore.getState();
                ws.send(
                    JSON.stringify({
                        type: "join",
                        roomId: activeRoomId,
                        clientId: state.clientId,
                        role: state.role,
                        hostToken: state.hostToken,
                        nickname: state.nickname,
                        color: state.myColor,
                    }),
                );

                if (state.role === "host") {
                    const snap = getCurrentSnapshotRef.current?.();
                    if (snap?.nodes?.length) {
                        uploadAllNodesAssets(snap.nodes);
                        const sharedNodes = snap.nodes.map(sanitizeNodeForCollab);
                        ws.send(
                            JSON.stringify({
                                type: "sync_canvas",
                                roomId: activeRoomId,
                                clientId: state.clientId,
                                nodes: sharedNodes,
                                connections: snap.connections,
                                title: snap.title,
                            }),
                        );
                    }
                }
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    const currentRole = useCollabStore.getState().role;

                    if (data.type === "join_ack") {
                        setHostOnline(Boolean(data.isHostOnline));
                        // If viewer and server has a cached snapshot, load it!
                        if (currentRole === "viewer" && data.snapshot?.nodes?.length) {
                            const sanitizedNodes = data.snapshot.nodes.map(sanitizeNodeForCollab);
                            onRemoteCanvasUpdateRef.current?.(sanitizedNodes, data.snapshot.connections, data.snapshot.title);
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
                        if (currentRole === "host") {
                            const snapshot = getCurrentSnapshotRef.current?.();
                            if (snapshot) {
                                uploadAllNodesAssets(snapshot.nodes);
                                const sharedNodes = snapshot.nodes.map(sanitizeNodeForCollab);
                                ws.send(
                                    JSON.stringify({
                                        type: "sync_canvas",
                                        roomId: activeRoomId,
                                        clientId: useCollabStore.getState().clientId,
                                        nodes: sharedNodes,
                                        connections: snapshot.connections,
                                        title: snapshot.title,
                                    }),
                                );
                            }
                        }
                    } else if (data.type === "canvas_updated") {
                        if (currentRole === "viewer") {
                            const sanitizedNodes = (data.nodes || []).map(sanitizeNodeForCollab);
                            onRemoteCanvasUpdateRef.current?.(sanitizedNodes, data.connections || [], data.title);
                            // Preload assets
                            for (const node of sanitizedNodes) {
                                if (node.metadata?.storageKey) {
                                    void ensureCollabAssetCached(node.metadata.storageKey, node.type === "video" || node.type === "audio");
                                }
                            }
                        }
                    } else if (data.type === "nodes_patched") {
                        if (currentRole === "viewer") {
                            const sanitizedNodes = (data.nodes || []).map(sanitizeNodeForCollab);
                            onRemoteNodesPatchRef.current?.(sanitizedNodes, data.connections || []);
                            for (const node of sanitizedNodes) {
                                if (node.metadata?.storageKey) {
                                    void ensureCollabAssetCached(node.metadata.storageKey, node.type === "video" || node.type === "audio");
                                }
                            }
                        }
                    } else if (data.type === "node_generation_status") {
                        if (currentRole === "viewer") {
                            const sanitizedMeta = data.metadata ? sanitizeMetadataForCollab(data.metadata) : undefined;
                            onRemoteGenerationStatusRef.current?.(data.nodeId, data.status, data.errorDetails, sanitizedMeta);
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

            ws.onclose = (event) => {
                if (isUnmounted) return;
                setStatus("disconnected");
                // Only try reconnect if not intentional close (1000)
                if (event.code !== 1000) {
                    reconnectTimerRef.current = setTimeout(connect, 3000);
                }
            };
        };

        connect();

        return () => {
            isUnmounted = true;
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            if (wsRef.current) {
                wsRef.current.close(1000, "leave");
                wsRef.current = null;
            }
        };
    }, [activeRoomId, role, hostToken, setStatus, setOnlineUsers, updatePeerPresence, setHostOnline]);

    return {
        broadcastCanvasSync,
        broadcastNodesPatch,
        broadcastGenerationStatus,
        broadcastCursor,
    };
}
