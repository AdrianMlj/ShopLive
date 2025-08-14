const http = require('http');
const WebSocket = require('ws');
const os = require('os');

// Fonction pour obtenir l'IP locale
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
console.log(`IP du serveur: ${LOCAL_IP}`);

// Render fournit le port via une variable d'environnement
const PORT = process.env.PORT || 9090;

// Création du serveur HTTP
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WebSocket Signaling Server is running\n');
});

const wss = new WebSocket.Server({ server });

// Stockage des connexions
const viewers = new Map();
const streamers = new Map();

function broadcastActiveStreamers() {
    const activeAdmins = Array.from(streamers.keys());
    viewers.forEach((viewerData) => {
        if (viewerData.socket.readyState === WebSocket.OPEN) {
            viewerData.socket.send(JSON.stringify({
                type: 'activeStreamers',
                streamers: activeAdmins
            }));
        }
    });
}

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`Nouvelle connexion depuis ${clientIP}`);

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.type === 'streamer' && data.adminId) {
                const adminIdStr = data.adminId.toString();
                streamers.set(adminIdStr, ws);
                ws.isStreamer = true;
                ws.adminId = adminIdStr;
                broadcastActiveStreamers();
            }
            else if (data.type === 'viewer' && data.viewerId && data.adminId) {
                const adminIdStr = data.adminId.toString();
                viewers.set(data.viewerId, { socket: ws, adminId: adminIdStr });
                ws.viewerId = data.viewerId;
                ws.adminId = adminIdStr;

                const streamerWs = streamers.get(adminIdStr);
                if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
                    streamerWs.send(JSON.stringify({
                        type: 'newViewer',
                        viewerId: data.viewerId
                    }));
                } else {
                    ws.send(JSON.stringify({
                        type: 'streamerUnavailable',
                        adminId: adminIdStr
                    }));
                }
            }
            else if (data.type === 'offer' && data.viewerId) {
                const viewerData = viewers.get(data.viewerId);
                if (viewerData && viewerData.socket.readyState === WebSocket.OPEN) {
                    viewerData.socket.send(JSON.stringify({
                        type: 'offer',
                        offer: data.offer,
                        viewerId: data.viewerId
                    }));
                }
            }
            else if (data.type === 'answer' && data.viewerId) {
                const viewerData = viewers.get(data.viewerId);
                if (viewerData) {
                    const streamerWs = streamers.get(viewerData.adminId);
                    if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
                        streamerWs.send(JSON.stringify({
                            type: 'answer',
                            answer: data.answer,
                            viewerId: data.viewerId
                        }));
                    }
                }
            }
            else if (data.type === 'candidate') {
                if (data.target === 'viewer' && data.viewerId) {
                    const viewerData = viewers.get(data.viewerId);
                    if (viewerData && viewerData.socket.readyState === WebSocket.OPEN) {
                        viewerData.socket.send(JSON.stringify({
                            type: 'candidate',
                            candidate: data.candidate,
                            viewerId: data.viewerId
                        }));
                    }
                } else if (data.target === 'streamer' && data.viewerId) {
                    const viewerData = viewers.get(data.viewerId);
                    if (viewerData) {
                        const streamer = streamers.get(viewerData.adminId);
                        if (streamer && streamer.readyState === WebSocket.OPEN) {
                            streamer.send(JSON.stringify({
                                type: 'candidate',
                                candidate: data.candidate,
                                viewerId: data.viewerId
                            }));
                        }
                    }
                }
            }
            else if (data.type === 'getActiveStreamers') {
                ws.send(JSON.stringify({
                    type: 'activeStreamers',
                    streamers: Array.from(streamers.keys())
                }));
            }

        } catch (error) {
            console.error(`Erreur parsing JSON:`, error);
        }
    });

    ws.on('close', () => {
        if (ws.viewerId) viewers.delete(ws.viewerId);
        if (ws.isStreamer && ws.adminId) {
            streamers.delete(ws.adminId);
            broadcastActiveStreamers();
        }
    });
});

// Heartbeat
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Lancer le serveur
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur WebSocket démarré sur ws://0.0.0.0:${PORT}`);
});
