import http from "node:http";
import { attachCollabServer, collabHttpMiddleware, getLocalIpAddress } from "./collab-server.mjs";

const PORT = Number(process.env.COLLAB_PORT) || 3002;
const server = http.createServer((req, res) => {
    collabHttpMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end("Infinite Canvas Collaboration Server");
    });
});

attachCollabServer(server);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[CollabServer] Standalone server running at http://0.0.0.0:${PORT}`);
    console.log(`[CollabServer] LAN access: http://${getLocalIpAddress()}:${PORT}`);
});
