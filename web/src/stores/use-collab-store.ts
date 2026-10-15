import { create } from "zustand";
import { nanoid } from "nanoid";
import type { CollabPeerPresence, CollabRole, CollabStatus, CollabUser } from "@/types/collaboration";

const PRESET_COLORS = [
    "#ef4444", // red
    "#f97316", // orange
    "#10b981", // emerald
    "#06b6d4", // cyan
    "#3b82f6", // blue
    "#8b5cf6", // purple
    "#ec4899", // pink
];

function getRandomColor() {
    return PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
}

const DEFAULT_NICKNAME = `创作者_${nanoid(4)}`;
const NICKNAME_KEY = "infinite-canvas:collab_nickname";
const COLOR_KEY = "infinite-canvas:collab_color";

function getStoredNickname() {
    try {
        return localStorage.getItem(NICKNAME_KEY) || DEFAULT_NICKNAME;
    } catch {
        return DEFAULT_NICKNAME;
    }
}

function getStoredColor() {
    try {
        const stored = localStorage.getItem(COLOR_KEY);
        if (stored) return stored;
        const color = getRandomColor();
        localStorage.setItem(COLOR_KEY, color);
        return color;
    } catch {
        return getRandomColor();
    }
}

type CollabStore = {
    activeRoomId: string | null;
    role: CollabRole;
    status: CollabStatus;
    hostToken: string | null;
    nickname: string;
    myColor: string;
    clientId: string;
    onlineUsers: CollabUser[];
    peerPresences: Record<string, CollabPeerPresence>;
    hostOnline: boolean;
    collabModalOpen: boolean;
    lanIp: string;

    startCollaboration: (roomId: string, role: CollabRole, hostToken?: string) => void;
    disconnect: () => void;
    setNickname: (name: string) => void;
    setStatus: (status: CollabStatus) => void;
    setOnlineUsers: (users: CollabUser[], hostId?: string) => void;
    updatePeerPresence: (presence: CollabPeerPresence) => void;
    removePeerPresence: (clientId: string) => void;
    setHostOnline: (online: boolean) => void;
    setCollabModalOpen: (open: boolean) => void;
    setLanIp: (ip: string) => void;
    setHostToken: (token: string) => void;
};

export const useCollabStore = create<CollabStore>((set, get) => ({
    activeRoomId: null,
    role: "viewer",
    status: "disconnected",
    hostToken: null,
    nickname: getStoredNickname(),
    myColor: getStoredColor(),
    clientId: nanoid(8),
    onlineUsers: [],
    peerPresences: {},
    hostOnline: true,
    collabModalOpen: false,
    lanIp: window.location.hostname === "localhost" ? "127.0.0.1" : window.location.hostname,

    startCollaboration: (roomId, role, hostToken) => {
        set({
            activeRoomId: roomId,
            role,
            hostToken: hostToken || (role === "host" ? `host-${nanoid(12)}` : null),
            status: "connecting",
        });
    },

    disconnect: () => {
        set({
            activeRoomId: null,
            status: "disconnected",
            onlineUsers: [],
            peerPresences: {},
        });
    },

    setNickname: (name) => {
        const trimmed = name.trim() || DEFAULT_NICKNAME;
        try {
            localStorage.setItem(NICKNAME_KEY, trimmed);
        } catch {
            // ignore
        }
        set({ nickname: trimmed });
    },

    setStatus: (status) => set({ status }),

    setOnlineUsers: (users, hostId) => {
        set((state) => ({
            onlineUsers: users,
            hostOnline: hostId ? users.some((u) => u.id === hostId) : state.hostOnline,
        }));
    },

    updatePeerPresence: (presence) => {
        set((state) => ({
            peerPresences: {
                ...state.peerPresences,
                [presence.clientId]: presence,
            },
        }));
    },

    removePeerPresence: (clientId) => {
        set((state) => {
            const next = { ...state.peerPresences };
            delete next[clientId];
            return { peerPresences: next };
        });
    },

    setHostOnline: (online) => set({ hostOnline: online }),
    setCollabModalOpen: (open) => set({ collabModalOpen: open }),
    setLanIp: (ip) => set({ lanIp: ip }),
    setHostToken: (token) => set({ hostToken: token }),
}));
