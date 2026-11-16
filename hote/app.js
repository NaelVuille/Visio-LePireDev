    // ===================================================================
    //  Configuration
    // ===================================================================
    const HOST_ID = 'ETML-LePireDev-2026';

    // ===================================================================
    //  Réseau : STUN + TURN
    //  Le TURN est INDISPENSABLE quand les 2 PC sont sur des réseaux différents.
    //  Créez un compte gratuit (sans carte) sur https://www.expressturn.com/ et renseignez TURN_USERNAME / TURN_PASSWORD.
    // ===================================================================
    //  (Version Cloudflare : les identifiants TURN sont récupérés auprès du Worker.)
    const TURN_USERNAME = '000000002109837271';
    const TURN_PASSWORD = 'nZjelETsJIWt2hUeuio9VesdveQ=';

    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ].concat(TURN_USERNAME && TURN_PASSWORD ? [{
            urls: [
                'turn:free.expressturn.com:3478',
                'turn:free.expressturn.com:3478?transport=tcp',
                'turn:free.expressturn.com:80',
                'turn:free.expressturn.com:80?transport=tcp',
                'turn:free.expressturn.com:443',
                'turn:free.expressturn.com:443?transport=tcp'
            ],
            username: TURN_USERNAME,
            credential: TURN_PASSWORD
        }] : []),
        iceCandidatePoolSize: 4
    };
    const iceReady = Promise.resolve();

    /** Bandeau d'erreur réseau visible à l'écran (diagnostic) */
    function showNetWarn(msg) {
        var el = document.getElementById('netWarn');
        if (!el) return;
        el.textContent = msg;
        el.style.display = msg ? 'block' : 'none';
    }
    if (!TURN_USERNAME) {
        console.warn('Aucun serveur TURN configuré : la connexion entre réseaux différents échouera probablement.');
    }

    // ===================================================================
    //  État
    // ===================================================================
    let peer = null;
    let hostStream = null;
    let noMediaMode = false;     // F2 = sans caméra/micro

    // Session en cours
    let currentDataConn = null;
    let currentCalls = [];
    let currentInvitePeerId = null;
    let candidateState = 'idle'; // 'idle' | 'waiting_host' | 'live'
    let mode = 'A';              // A = Caméra en grand, B = Écran en grand

    // Flux reçus du candidat
    let remoteCameraStream = null;
    let remoteScreenStream = null;

    // ===================================================================
    //  F2 — Mode sans caméra ni micro pour l'Hôte
    // ===================================================================
    document.addEventListener('keydown', function (e) {
        if (e.key === 'F2') {
            e.preventDefault();
            if (!noMediaMode) {
                noMediaMode = true;
                hostStream = createDummyStream();
                document.getElementById('hostPreviewWaiting').srcObject = hostStream;
                document.getElementById('hostPreviewLive').srcObject = hostStream;
                document.getElementById('errorMsg').textContent =
                    '⚡ Mode sans caméra/micro activé pour la régie (F2)';
                document.getElementById('errorMsg').style.color = '#0000ac';
                if (!peer) createPeer();
            }
        }
    });

    function createDummyStream() {
        var canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, 640, 480);
        var stream = canvas.captureStream(1);

        try {
            var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            var oscillator = audioCtx.createOscillator();
            var dst = oscillator.connect(audioCtx.createMediaStreamDestination());
            oscillator.start();
            var audioTrack = dst.stream.getAudioTracks()[0];
            audioTrack.enabled = false;
            stream.addTrack(audioTrack);
        } catch (e) {
            console.warn('AudioContext dummy track régie:', e);
        }

        return stream;
    }

    // ===================================================================
    //  Affichage selon l'état
    // ===================================================================

    function updateView() {
        var waitingEl = document.getElementById('waitingScreen');
        var preEl = document.getElementById('preSessionScreen');
        var liveEl = document.getElementById('liveScreen');

        if (!currentInvitePeerId) {
            // Aucun invité connecté
            waitingEl.style.display = 'flex';
            preEl.style.display = 'none';
            liveEl.style.display = 'none';
        } else if (candidateState !== 'live') {
            // Invité en pré-session ou en attente du clic "Prêt" de l'hôte
            waitingEl.style.display = 'none';
            preEl.style.display = 'flex';
            liveEl.style.display = 'none';

            // Lier les flux à la disposition Pré-session
            if (remoteScreenStream) {
                document.getElementById('preScreenVideo').srcObject = remoteScreenStream;
            }
            if (remoteCameraStream) {
                document.getElementById('preCameraVideo').srcObject = remoteCameraStream;
            }

            var badgeEl = document.getElementById('preBadge');
            var titleEl = document.getElementById('preTitle');
            var subEl = document.getElementById('preSubtitle');
            var btnReady = document.getElementById('btnReady');

            if (candidateState === 'waiting_host') {
                badgeEl.className = 'badge-waiting-host';
                badgeEl.textContent = '🔔 CONNEXION DEMANDÉE';
                titleEl.textContent = 'Le candidat a cliqué sur « Se connecter » !';
                subEl.textContent = "Il voit l'animation de connexion. Cliquez sur « Prêt » pour démarrer la session.";
                btnReady.style.display = 'inline-flex';
            } else {
                badgeEl.className = 'badge-warning';
                badgeEl.textContent = '⏳ PRÉ-SESSION';
                titleEl.textContent = "Le candidat est connecté — Il n'a PAS ENCORE cliqué sur « Se connecter »";
                subEl.textContent = "Ses flux sont actifs ci-dessous en régie de surveillance. L'écran d'accueil est affiché chez lui.";
                btnReady.style.display = 'none';
            }
        } else {
            // Hôte a cliqué sur "Prêt" -> Session en direct
            waitingEl.style.display = 'none';
            preEl.style.display = 'none';
            liveEl.style.display = 'block';

            applyLiveMode();
        }
    }

    function applyLiveMode() {
        document.getElementById('btnModeA').classList.toggle('active', mode === 'A');
        document.getElementById('btnModeB').classList.toggle('active', mode === 'B');

        var cam = document.getElementById('liveCameraVideo');
        var scr = document.getElementById('liveScreenVideo');

        if (remoteCameraStream) cam.srcObject = remoteCameraStream;
        if (remoteScreenStream) scr.srcObject = remoteScreenStream;

        if (mode === 'A') {
            cam.className = 'video-main';
            scr.className = 'video-pip';
        } else {
            scr.className = 'video-main';
            cam.className = 'video-pip';
        }
    }

    function setMode(m) {
        mode = m;
        applyLiveMode();
    }

    // ===================================================================
    //  Initialisation
    // ===================================================================

    async function init() {
        try {
            hostStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            document.getElementById('hostPreviewWaiting').srcObject = hostStream;
            document.getElementById('hostPreviewLive').srcObject = hostStream;
        } catch (err) {
            console.error('Erreur caméra/micro hôte:', err);
            document.getElementById('errorMsg').textContent =
                "Caméra/micro non détecté. Appuyez sur [F2] pour démarrer la régie sans caméra ni micro.";
            return;
        }

        await iceReady;   // serveurs TURN chargés avant d'ouvrir PeerJS
        createPeer();
    }

    function createPeer() {
        peer = new Peer(HOST_ID, { config: ICE_CONFIG });

        peer.on('open', function (id) {
            console.log('Régie prête sur ID:', id);
            document.getElementById('errorMsg').textContent = '';
        });

        peer.on('error', function (err) {
            console.error('Peer error:', err);
            if (err.type === 'unavailable-id') {
                document.getElementById('errorMsg').textContent =
                    'ID régie déjà occupé. Nouvelle tentative dans 4 s…';
                setTimeout(function () {
                    document.getElementById('errorMsg').textContent = '';
                    createPeer();
                }, 4000);
            } else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(err.type) !== -1) {
                // Perte de connexion au serveur PeerJS : reconnexion automatique
                document.getElementById('errorMsg').style.color = '#0000ac';
                document.getElementById('errorMsg').textContent = 'Connexion au serveur perdue — reconnexion en cours…';
                scheduleReconnect();
            } else {
                document.getElementById('errorMsg').textContent = 'Erreur PeerJS : ' + err.message;
            }
        });

        // Canal de données (contrôle et détection d'état)
        peer.on('connection', function (conn) {
            if (currentInvitePeerId && conn.peer !== currentInvitePeerId) {
                try { conn.close(); } catch (_) {}
                return;
            }

            currentInvitePeerId = conn.peer;

            // Diagnostic : le signal est arrivé, mais le canal peut ne jamais s'ouvrir si le réseau bloque le P2P
            var checkedConn = conn;
            setTimeout(function () {
                if (checkedConn === currentDataConn && !checkedConn.open) {
                    showNetWarn(TURN_USERNAME
                        ? "Un candidat s'est annoncé mais la liaison réseau n'aboutit pas. Rechargez les 2 pages."
                        : 'Un candidat s\'est annoncé mais la liaison réseau échoue : identifiants ExpressTURN manquants (TURN_USERNAME / TURN_PASSWORD).');
                }
            }, 12000);
            checkedConn.on('open', function () { showNetWarn(''); });
            currentDataConn = conn;

            conn.on('data', function (data) {
                console.log('Message reçu du candidat:', data);
                if (data && data.type === 'status') {
                    if (data.state) {
                        candidateState = data.state;
                    } else {
                        candidateState = data.started ? 'live' : 'idle';
                    }
                    updateView();
                }
            });

            conn.on('close', function () {
                console.log('Connexion candidat fermée');
                resetSession();
            });

            conn.on('error', function (err) {
                console.error('Data conn error:', err);
                resetSession();
            });

            updateView();
        });

        // Réception des flux multimédias
        peer.on('call', function (call) {
            if (currentInvitePeerId && call.peer !== currentInvitePeerId) {
                try { call.close(); } catch (_) {}
                return;
            }

            if (!currentInvitePeerId) {
                currentInvitePeerId = call.peer;
            }

            handleIncomingCall(call);
        });

        peer.on('disconnected', function () {
            document.getElementById('errorMsg').style.color = '#0000ac';
            document.getElementById('errorMsg').textContent = 'Connexion au serveur perdue — reconnexion en cours…';
            scheduleReconnect();
        });
    }

    // Reconnexion automatique au serveur PeerJS (réessaie toutes les 3 s jusqu'au succès)
    var reconnectTimer = null;
    function scheduleReconnect() {
        if (reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            if (!peer) return;
            if (peer.destroyed) {
                createPeer();                      // pair détruit : on en recrée un avec le même ID
            } else if (peer.disconnected) {
                try { peer.reconnect(); } catch (_) {}
                // si toujours déconnecté dans 5 s, on réessaie
                setTimeout(function () { if (peer && peer.disconnected) scheduleReconnect(); }, 5000);
            }
        }, 3000);
    }

    // ===================================================================
    //  Gestion des Appels Entrants
    // ===================================================================

    function handleIncomingCall(call) {
        var type = (call.metadata && call.metadata.type) || 'camera';
        console.log('Appel entrant type:', type, 'depuis:', call.peer);

        if (type === 'camera') {
            call.answer(hostStream);
            call.on('stream', function (stream) {
                remoteCameraStream = stream;
                updateView();
            });
        } else if (type === 'screen') {
            call.answer(); // receive-only
            call.on('stream', function (stream) {
                remoteScreenStream = stream;
                updateView();
            });
        }

        call.on('close', function () {
            console.log('Appel fermé:', type);
        });
        call.on('error', function (err) {
            console.error('Call error (' + type + '):', err);
        });

        currentCalls.push(call);
        updateView();
    }

    // ===================================================================
    //  Raccrocher / Retour Pré-session & Déconnexion
    // ===================================================================

    /** L'hôte clique sur "Prêt" : débloque l'animation de chargement du client et lance le direct */
    function hostReady() {
        if (currentDataConn && currentDataConn.open) {
            try {
                currentDataConn.send({ type: 'host_ready' });
            } catch (_) {}
        }
        candidateState = 'live';
        updateView();
    }

    /** Raccroche la session en direct : renvoie le candidat sur "Se connecter" et remet l'hôte en pré-session */
    function hangup() {
        if (currentDataConn && currentDataConn.open) {
            try {
                currentDataConn.send({ type: 'hangup' });
            } catch (_) {}
        }
        // Repasse l'état en pré-session sans couper les flux (masque le bouton "Prêt" jusqu'au prochain clic)
        candidateState = 'idle';
        updateView();
    }

    /** Déconnecte complètement le poste (ex: fin d'épreuve pour changer de candidat) */
    function ejectSession() {
        if (currentDataConn && currentDataConn.open) {
            try {
                currentDataConn.send({ type: 'eject' });
            } catch (_) {}
        }
        setTimeout(resetSession, 200);
    }

    function resetSession() {
        if (currentDataConn) {
            try { currentDataConn.close(); } catch (_) {}
            currentDataConn = null;
        }

        currentCalls.forEach(function (c) {
            try { c.close(); } catch (_) {}
        });
        currentCalls = [];
        currentInvitePeerId = null;
        candidateState = 'idle';
        remoteCameraStream = null;
        remoteScreenStream = null;
        mode = 'A';

        document.getElementById('preScreenVideo').srcObject = null;
        document.getElementById('preCameraVideo').srcObject = null;
        document.getElementById('liveCameraVideo').srcObject = null;
        document.getElementById('liveScreenVideo').srcObject = null;

        updateView();
    }

    // Démarrage
    init();
