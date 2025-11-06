// server-livraison.js
const WebSocket = require('ws');
const http = require('http');
const os = require('os');

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
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log('🚚 Serveur de géolocalisation livreurs prêt');

// Stockage des connexions
const livreurs = new Map();        // livreurId => { socket, infos, position }
const clients = new Map();         // clientId => { socket, livreurSuivi }
const commandes = new Map();       // commandeId => { infos, livreurId }

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`🔗 Nouvelle connexion: ${clientIP}`);

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`📨 ${data.type} de ${clientIP}`);

            switch (data.type) {
                
                // === LIVREUR ===
                case 'livreur_login':
                    handleLivreurLogin(ws, data, clientIP);
                    break;
                    
                case 'livreur_position':
                    handleLivreurPosition(ws, data);
                    break;
                    
                case 'livreur_status':
                    handleLivreurStatus(ws, data);
                    break;
                    
                // === CLIENT ===  
                case 'client_login':
                    handleClientLogin(ws, data, clientIP);
                    break;
                    
                case 'client_track_livreur':
                    handleClientTrackLivreur(ws, data);
                    break;
                    
                // === COMMANDES ===
                case 'nouvelle_commande':
                    handleNouvelleCommande(data);
                    break;
                    
                case 'livreur_accept_commande':
                    handleLivreurAcceptCommande(ws, data);
                    break;
                    
                case 'commande_status':
                    handleCommandeStatus(data);
                    break;

                // === ADMIN ===
                case 'admin_get_livreurs':
                    handleAdminGetLivreurs(ws);
                    break;
            }

        } catch (error) {
            console.error('❌ Erreur parsing:', error);
        }
    });

    ws.on('close', () => {
        console.log(`🔌 Déconnexion: ${clientIP}`);
        handleDeconnexion(ws);
    });

    ws.on('error', (error) => {
        console.error('💥 Erreur WebSocket:', error);
    });
});

// === GESTIONNAIRES D'ÉVÉNEMENTS ===

function handleLivreurLogin(ws, data, clientIP) {
    const { livreurId, nom, vehicule } = data;
    
    livreurs.set(livreurId, {
        socket: ws,
        infos: { livreurId, nom, vehicule, clientIP },
        position: null,
        status: 'disponible',
        commandeActuelle: null
    });
    
    ws.livreurId = livreurId;
    
    console.log(`👨‍🍳 Livreur connecté: ${nom} (${livreurId})`);
    
    // Accusé réception
    ws.send(JSON.stringify({
        type: 'login_success',
        message: 'Connexion réussie'
    }));
    
    // Notifier les clients que le livreur est disponible
    broadcastToClients({
        type: 'livreur_disponible',
        livreurId,
        nom,
        vehicule
    });
}

function handleLivreurPosition(ws, data) {
    const livreurId = ws.livreurId;
    if (!livreurId) return;
    
    const { latitude, longitude, accuracy, speed, timestamp } = data;
    
    const livreur = livreurs.get(livreurId);
    if (livreur) {
        livreur.position = {
            latitude,
            longitude,
            accuracy,
            speed,
            timestamp: timestamp || new Date().toISOString()
        };
        
        console.log(`📍 Position ${livreurId}: ${latitude}, ${longitude}`);
        
        // Notifier les clients qui suivent ce livreur
        broadcastPositionToFollowers(livreurId, livreur.position);
        
        // Notifier l'admin si une commande est en cours
        if (livreur.commandeActuelle) {
            notifyAdminPositionCommande(livreurId, livreur.position, livreur.commandeActuelle);
        }
    }
}

function handleLivreurStatus(ws, data) {
    const livreurId = ws.livreurId;
    if (!livreurId) return;
    
    const { status } = data;
    const livreur = livreurs.get(livreurId);
    
    if (livreur) {
        livreur.status = status;
        console.log(`🔄 Statut ${livreurId}: ${status}`);
        
        broadcastToClients({
            type: 'livreur_status',
            livreurId,
            status
        });
    }
}

function handleClientLogin(ws, data, clientIP) {
    const { clientId } = data;
    
    clients.set(clientId, {
        socket: ws,
        clientId,
        livreurSuivi: null,
        clientIP
    });
    
    ws.clientId = clientId;
    
    console.log(`👤 Client connecté: ${clientId}`);
    
    // Envoyer la liste des livreurs disponibles
    const livreursDisponibles = getLivreursDisponibles();
    ws.send(JSON.stringify({
        type: 'livreurs_disponibles',
        livreurs: livreursDisponibles
    }));
}

function handleClientTrackLivreur(ws, data) {
    const { clientId, livreurId } = data;
    const client = clients.get(clientId);
    
    if (client) {
        client.livreurSuivi = livreurId;
        console.log(`👁️ Client ${clientId} suit livreur ${livreurId}`);
        
        // Envoyer la position actuelle si disponible
        const livreur = livreurs.get(livreurId);
        if (livreur && livreur.position) {
            ws.send(JSON.stringify({
                type: 'livreur_position',
                ...livreur.position,
                livreurId
            }));
        }
    }
}

function handleNouvelleCommande(data) {
    const { commandeId, clientId, restaurant, adresseLivraison, items } = data;
    
    commandes.set(commandeId, {
        commandeId,
        clientId,
        restaurant,
        adresseLivraison,
        items,
        status: 'en_attente',
        livreurId: null,
        timestamp: new Date()
    });
    
    console.log(`📦 Nouvelle commande: ${commandeId}`);
    
    // Notifier tous les livreurs disponibles
    broadcastToLivreurs({
        type: 'nouvelle_commande',
        commandeId,
        restaurant,
        adresseLivraison,
        items
    });
}

function handleLivreurAcceptCommande(ws, data) {
    const { commandeId } = data;
    const livreurId = ws.livreurId;
    
    const commande = commandes.get(commandeId);
    const livreur = livreurs.get(livreurId);
    
    if (commande && livreur) {
        // Assigner la commande au livreur
        commande.livreurId = livreurId;
        commande.status = 'en_cours';
        livreur.commandeActuelle = commandeId;
        livreur.status = 'en_livraison';
        
        console.log(`✅ Livreur ${livreurId} accepte commande ${commandeId}`);
        
        // Notifier le client
        const client = clients.get(commande.clientId);
        if (client && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify({
                type: 'commande_acceptee',
                commandeId,
                livreurId: livreur.infos.nom,
                position: livreur.position
            }));
        }
        
        // Notifier le livreur
        ws.send(JSON.stringify({
            type: 'commande_confirmee',
            commande: commande
        }));
        
        // Notifier tous les clients que le livreur n'est plus disponible
        broadcastToClients({
            type: 'livreur_occupe',
            livreurId
        });
    }
}

function handleCommandeStatus(data) {
    const { commandeId, status } = data;
    const commande = commandes.get(commandeId);
    
    if (commande) {
        commande.status = status;
        console.log(`📊 Commande ${commandeId}: ${status}`);
        
        // Notifier le client
        const client = clients.get(commande.clientId);
        if (client) {
            client.socket.send(JSON.stringify({
                type: 'commande_status',
                commandeId,
                status
            }));
        }
        
        // Si livrée, libérer le livreur
        if (status === 'livree') {
            const livreur = livreurs.get(commande.livreurId);
            if (livreur) {
                livreur.commandeActuelle = null;
                livreur.status = 'disponible';
                
                // Notifier que le livreur est à nouveau disponible
                broadcastToClients({
                    type: 'livreur_disponible',
                    livreurId: livreur.infos.livreurId,
                    nom: livreur.infos.nom,
                    vehicule: livreur.infos.vehicule
                });
            }
        }
    }
}

function handleAdminGetLivreurs(ws) {
    const livreursData = Array.from(livreurs.values()).map(l => ({
        ...l.infos,
        position: l.position,
        status: l.status,
        commandeActuelle: l.commandeActuelle
    }));
    
    ws.send(JSON.stringify({
        type: 'livreurs_data',
        livreurs: livreursData
    }));
}

function handleDeconnexion(ws) {
    // Si c'est un livreur
    if (ws.livreurId) {
        const livreur = livreurs.get(ws.livreurId);
        if (livreur) {
            console.log(`👋 Livreur déconnecté: ${livreur.infos.nom}`);
            
            // Notifier les clients
            broadcastToClients({
                type: 'livreur_deconnecte',
                livreurId: ws.livreurId
            });
            
            livreurs.delete(ws.livreurId);
        }
    }
    
    // Si c'est un client
    if (ws.clientId) {
        clients.delete(ws.clientId);
        console.log(`👋 Client déconnecté: ${ws.clientId}`);
    }
}

// === FONCTIONS UTILITAIRES ===

function broadcastPositionToFollowers(livreurId, position) {
    clients.forEach(client => {
        if (client.livreurSuivi === livreurId && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify({
                type: 'livreur_position',
                ...position,
                livreurId
            }));
        }
    });
}

function broadcastToClients(message) {
    clients.forEach(client => {
        if (client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(JSON.stringify(message));
        }
    });
}

function broadcastToLivreurs(message) {
    livreurs.forEach(livreur => {
        if (livreur.socket.readyState === WebSocket.OPEN && livreur.status === 'disponible') {
            livreur.socket.send(JSON.stringify(message));
        }
    });
}

function getLivreursDisponibles() {
    return Array.from(livreurs.values())
        .filter(l => l.status === 'disponible')
        .map(l => ({
            livreurId: l.infos.livreurId,
            nom: l.infos.nom,
            vehicule: l.infos.vehicule,
            position: l.position
        }));
}

function notifyAdminPositionCommande(livreurId, position, commandeId) {
    // Ici vous pouvez notifier un panel admin ou logger la position
    console.log(`📋 LIVRAISON - Commande: ${commandeId}, Livreur: ${livreurId}, Position: ${position.latitude}, ${position.longitude}`);
}

// === MAINTENANCE ===

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// === DÉMARRAGE ===

const PORT = 9091; // Port différent de votre serveur stream
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur livraison démarré sur:`);
    console.log(`   - Local: ws://localhost:${PORT}`);
    console.log(`   - Réseau: ws://${LOCAL_IP}:${PORT}`);
    console.log(`\n📊 Endpoints:`);
    console.log(`   👨‍🍳 Livreurs: Connexion WebSocket + messages position`);
    console.log(`   👤 Clients: Suivi livreurs en temps réel`);
    console.log(`   🏪 Restaurants: Notification nouvelles commandes`);
    console.log(`   👨‍💼 Admin: Monitoring toutes les livraisons`);
});