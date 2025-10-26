const fs = require('fs');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');

// Fonction pour obtenir l'IP locale
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return '127.0.0.1';
}

const LOCAL_IP = getLocalIP();
console.log(`🌐 IP du serveur: ${LOCAL_IP}`);

// Développement: forcer HTTP (WS) pour éviter les certificats
const useHTTPS = false;
const server = http.createServer();
console.log('🌐 Mode HTTP (WS) activé');

const wss = new WebSocket.Server({ server });

const viewers = new Map(); // viewerId => { socket, adminId }
const streamers = new Map(); // adminId => socket

console.log('🚀 Serveur WebSocket prêt');

function broadcastActiveStreamers() {
    const activeAdmins = Array.from(streamers.keys());
    console.log(`📡 Diffusion des streamers actifs: [${activeAdmins.join(', ')}]`);
    
    viewers.forEach((viewerData, viewerId) => {
        if (viewerData.socket.readyState === WebSocket.OPEN) {
            viewerData.socket.send(JSON.stringify({
                type: 'activeStreamers',
                streamers: activeAdmins
            }));
        }
    });
}

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress || req.connection.remoteAddress;
    console.log(`🙋‍♂️ Nouvelle connexion depuis ${clientIP}`);

    // Ping/Pong pour maintenir la connexion
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', msg => {
        try {
            const data = JSON.parse(msg);
            console.log(`📩 Message de ${clientIP}:`, data.type);

            // Streamer se connecte
            if (data.type === 'streamer' && data.adminId) {
                const adminIdStr = data.adminId.toString();
                streamers.set(adminIdStr, ws);
                ws.isStreamer = true;
                ws.adminId = adminIdStr;
                ws.clientIP = clientIP;
                console.log(`🎥 Streamer connecté [adminId=${adminIdStr}] depuis ${clientIP}`);
                broadcastActiveStreamers();
            }

            // Viewer se connecte
            else if (data.type === 'viewer' && data.viewerId && data.adminId) {
                const adminIdStr = data.adminId.toString();
            
                console.log('DEBUG - Clés dans streamers:', Array.from(streamers.keys()));
                console.log('DEBUG - Recherche streamer avec adminId:', adminIdStr, typeof adminIdStr);
            
                viewers.set(data.viewerId, { socket: ws, adminId: adminIdStr, clientIP });
                ws.viewerId = data.viewerId;
                ws.adminId = adminIdStr;
                ws.clientIP = clientIP;
            
                console.log(`👁️ Viewer ${data.viewerId} depuis ${clientIP} demande le live de ${adminIdStr}`);
            
                const streamerWs = streamers.get(adminIdStr);
                if (streamerWs && streamerWs.readyState === WebSocket.OPEN) {
                    streamerWs.send(JSON.stringify({
                        type: 'newViewer',
                        viewerId: data.viewerId,
                        viewerIP: clientIP
                    }));
                    console.log(`✅ Notification envoyée au streamer ${adminIdStr}`);
                } else {
                    console.log(`❌ Streamer ${adminIdStr} non disponible`);
                    ws.send(JSON.stringify({
                        type: 'streamerUnavailable',
                        adminId: adminIdStr
                    }));
                }
            }
            

            // Offer du streamer vers viewer
            else if (data.type === 'offer' && data.viewerId) {
                const viewerData = viewers.get(data.viewerId);
                if (viewerData && viewerData.socket.readyState === WebSocket.OPEN) {
                    viewerData.socket.send(JSON.stringify({
                        type: 'offer',
                        offer: data.offer,
                        viewerId: data.viewerId
                    }));
                    console.log(`📤 Offer envoyée au viewer ${data.viewerId}`);
                } else {
                    console.log(`❌ Viewer ${data.viewerId} non trouvé ou déconnecté`);
                }
            }

            // Answer du viewer vers streamer
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
                        console.log(`📤 Answer envoyée au streamer ${viewerData.adminId}`);
                    }
                }
            }

            // ICE candidates
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

            // Demande de liste des streamers actifs
            else if (data.type === 'getActiveStreamers') {
                const activeAdmins = Array.from(streamers.keys());
                ws.send(JSON.stringify({
                    type: 'activeStreamers',
                    streamers: activeAdmins
                }));
            }

        } catch (error) {
            console.error(`❌ Erreur parsing JSON depuis ${clientIP}:`, error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Connexion fermée depuis ${clientIP}`);
        
        if (ws.viewerId) {
            viewers.delete(ws.viewerId);
            console.log(`👁️ Viewer ${ws.viewerId} déconnecté`);
        }

        if (ws.isStreamer && ws.adminId) {
            streamers.delete(ws.adminId);
            console.log(`🎥 Streamer ${ws.adminId} déconnecté`);
            
            // Notifier les viewers que le streamer est déconnecté
            viewers.forEach((viewerData, viewerId) => {
                if (viewerData.adminId === ws.adminId && viewerData.socket.readyState === WebSocket.OPEN) {
                    viewerData.socket.send(JSON.stringify({
                        type: 'streamerDisconnected',
                        adminId: ws.adminId
                    }));
                }
            });
            
            broadcastActiveStreamers();
        }
    });

    ws.on('error', (error) => {
        console.error(`❌ Erreur WebSocket depuis ${clientIP}:`, error);
    });

    // Envoyer la liste des streamers actifs au nouveau client
    setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
            broadcastActiveStreamers();
        }
    }, 1000);
});

// Heartbeat pour maintenir les connexions
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            console.log(`💀 Connexion morte détectée, fermeture...`);
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// Nettoyage régulier
setInterval(() => {
    let cleaned = 0;
    
    viewers.forEach((viewerData, viewerId) => {
        if (viewerData.socket.readyState !== WebSocket.OPEN) {
            viewers.delete(viewerId);
            cleaned++;
        }
    });

    streamers.forEach((ws, adminId) => {
        if (ws.readyState !== WebSocket.OPEN) {
            streamers.delete(adminId);
            cleaned++;
        }
    });

    if (cleaned > 0) {
        console.log(`🧹 Nettoyage: ${cleaned} connexions fermées supprimées`);
        broadcastActiveStreamers();
    }
}, 60000);

// Démarrage du serveur
const PORT = 9090;
server.listen(PORT, '0.0.0.0', () => {
    const protocol = useHTTPS ? 'wss' : 'ws';
    console.log(`🚀 Serveur ${protocol.toUpperCase()} démarré sur:`);
    console.log(`   - Local: ${protocol}://localhost:${PORT}`);
    console.log(`   - Réseau: ${protocol}://${LOCAL_IP}:${PORT}`);
    console.log(`   - Toutes interfaces: ${protocol}://0.0.0.0:${PORT}`);
    
    if (!useHTTPS) {
        console.log(`\n⚠️  ATTENTION: Mode HTTP non sécurisé activé`);
        console.log(`   Pour la production, générez des certificats SSL avec:`);
        console.log(`   openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`);
    }
});

// Gestion des signaux pour fermeture propre
process.on('SIGINT', () => {
    console.log('\n🛑 Arrêt du serveur...');
    clearInterval(interval);
    server.close(() => {
        console.log('✅ Serveur arrêté proprement');
        process.exit(0);
    });
});

// Logs de diagnostic au démarrage
console.log(`\n📊 Informations système:`);
console.log(`   - Node.js: ${process.version}`);
console.log(`   - Platform: ${process.platform}`);
console.log(`   - Architecture: ${process.arch}`);
console.log(`   - Interfaces réseau:`);

const interfaces = os.networkInterfaces();
Object.keys(interfaces).forEach(name => {
    interfaces[name].forEach(interface => {
        if (interface.family === 'IPv4') {
            const type = interface.internal ? '(interne)' : '(externe)';
            console.log(`     ${name}: ${interface.address} ${type}`);
        }
    });
});