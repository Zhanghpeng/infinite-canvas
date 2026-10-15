import React from "react";
import { useCollabStore } from "@/stores/use-collab-store";

export function CanvasCollabCursors() {
    const peerPresences = useCollabStore((s) => s.peerPresences);
    const presences = Object.values(peerPresences);

    if (presences.length === 0) return null;

    return (
        <div className="pointer-events-none absolute inset-0 z-40">
            {presences.map((peer) => {
                if (!peer.cursor) return null;
                const { x, y } = peer.cursor;
                return (
                    <div
                        key={peer.clientId}
                        className="absolute left-0 top-0 transition-transform duration-75 ease-out"
                        style={{
                            transform: `translate3d(${x}px, ${y}px, 0)`,
                        }}
                    >
                        {/* Custom colored cursor pointer */}
                        <svg
                            className="size-5 drop-shadow-md"
                            viewBox="0 0 24 24"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                            style={{ color: peer.color }}
                        >
                            <path
                                d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L11.7841 12.3673H5.65376Z"
                                fill="currentColor"
                                stroke="#ffffff"
                                strokeWidth="1.5"
                            />
                        </svg>

                        {/* Peer Nickname Badge */}
                        <div
                            className="ml-3 mt-1 inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold text-white shadow-sm"
                            style={{
                                backgroundColor: peer.color,
                            }}
                        >
                            {peer.nickname}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export function CanvasCollabSelectionOutlines({
    nodesMap,
}: {
    nodesMap: Record<string, { x: number; y: number; width: number; height: number }>;
}) {
    const peerPresences = useCollabStore((s) => s.peerPresences);
    const presences = Object.values(peerPresences);

    return (
        <div className="pointer-events-none absolute inset-0 z-30">
            {presences.map((peer) => {
                if (!peer.selectedNodeIds || peer.selectedNodeIds.length === 0) return null;
                return peer.selectedNodeIds.map((nodeId) => {
                    const rect = nodesMap[nodeId];
                    if (!rect) return null;
                    return (
                        <div
                            key={`${peer.clientId}-${nodeId}`}
                            className="absolute rounded-2xl transition-all duration-100 ease-out"
                            style={{
                                transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
                                width: rect.width,
                                height: rect.height,
                                border: `2px dashed ${peer.color}`,
                                boxShadow: `0 0 0 1px rgba(255,255,255,0.4), 0 0 12px ${peer.color}40`,
                            }}
                        >
                            <span
                                className="absolute -top-6 left-2 rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
                                style={{ backgroundColor: peer.color }}
                            >
                                {peer.nickname}
                            </span>
                        </div>
                    );
                });
            })}
        </div>
    );
}
