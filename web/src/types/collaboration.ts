import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type CollabRole = "host" | "viewer";

export type CollabStatus = "disconnected" | "connecting" | "connected";

export type CollabUser = {
    id: string;
    role: CollabRole;
    nickname: string;
    color: string;
};

export type CollabCursor = {
    x: number;
    y: number;
};

export type CollabPeerPresence = {
    clientId: string;
    nickname: string;
    color: string;
    cursor: CollabCursor | null;
    selectedNodeIds: string[];
};

export type CollabRoomSnapshot = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    title: string;
};
