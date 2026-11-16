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
    let cameraStream = null;
    let screenStream = null;
    let peer = null;
    let dataConn = null;
    let clientState = 'idle';    // 'idle' | 'waiting_host' | 'live'
    let noMediaMode = false;     // F2 = sans caméra ni micro
    let isConnectedToHost = false;

    // ===================================================================
    //  F2 — Raccourci sans caméra/micro
    // ===================================================================
    document.addEventListener('keydown', function (e) {
        if (e.key === 'F2') {
            e.preventDefault();
            noMediaMode = true;
            setStatus('⚡ Mode sans caméra/micro activé (F2)');
            // Si la modale est encore affichée, lancer l'autorisation avec F2
            if (document.getElementById('permissionModal').style.display !== 'none') {
                authorizeAndConnect();
            }
        }
    });

    /** Crée un flux vidéo noir et un audio silencieux pour remplacer cam/mic */
    function createDummyStream() {
        var canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, 640, 480);
        var stream = canvas.captureStream(1); // 1 fps

        try {
            var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            var oscillator = audioCtx.createOscillator();
            var dst = oscillator.connect(audioCtx.createMediaStreamDestination());
            oscillator.start();
            var audioTrack = dst.stream.getAudioTracks()[0];
            audioTrack.enabled = false;
            stream.addTrack(audioTrack);
        } catch (e) {
            console.warn('AudioContext dummy track non créé:', e);
        }

        return stream;
    }

    // ===================================================================
    //  Gestion des Écrans & Statuts
    // ===================================================================

    function showScreen1() {
        clientState = 'idle';
        document.getElementById('screen1').style.display = 'flex';
        document.getElementById('screen2').style.display = 'none';
        const btn = document.getElementById('btnConnect');
        btn.textContent = 'Se connecter';
        btn.style.display = 'inline-block';
        btn.disabled = false;
        document.getElementById('loadingBox').style.display = 'none';
        // Couper le son de l'hôte quand on est sur l'écran d'attente
        var remoteVid = document.getElementById('remoteVideo');
        remoteVid.muted = true;
    }

    function showWaitingHost() {
        clientState = 'waiting_host';
        document.getElementById('screen1').style.display = 'flex';
        document.getElementById('screen2').style.display = 'none';
        document.getElementById('btnConnect').style.display = 'none';
        document.getElementById('loadingBox').style.display = 'flex';
        document.getElementById('remoteVideo').muted = true;
    }

    function showScreen2() {
        clientState = 'live';
        document.getElementById('screen1').style.display = 'none';
        document.getElementById('screen2').style.display = 'block';
        document.getElementById('loadingBox').style.display = 'none';
        // Activer le son de l'hôte pendant l'appel
        var remoteVid = document.getElementById('remoteVideo');
        remoteVid.muted = false;
    }

    function showBlocking() {
        document.getElementById('blockingOverlay').style.display = 'flex';
    }

    function setStatus(msg) {
        console.log('[Status]', msg);
        var el = document.getElementById('statusText');
        if (el) el.textContent = msg;
    }

    // ===================================================================
    //  Initialisation des Flux (Caméra, Micro, Écran)
    // ===================================================================

    async function ensureStreams() {
        // 1. Caméra + Micro
        if (!cameraStream || !cameraStream.active) {
            if (noMediaMode) {
                cameraStream = createDummyStream();
            } else {
                try {
                    cameraStream = await navigator.mediaDevices.getUserMedia({
                        video: true,
                        audio: true
                    });
                } catch (camErr) {
                    console.warn('Caméra/Micro refusé ou absent. Bascule F2 automatique.');
                    cameraStream = createDummyStream();
                    noMediaMode = true;
                }
            }
        }
        document.getElementById('localVideo').srcObject = cameraStream;

        // 2. Partage d'écran
        if (!screenStream || !screenStream.active) {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'always' },
                audio: true // audio système si supporté
            });

            // Si le candidat coupe le partage d'écran via l'UI native du navigateur
            screenStream.getVideoTracks().forEach(function (track) {
                track.addEventListener('ended', function () {
                    showBlocking();
                });
            });
        }
    }

    // ===================================================================
    //  Étape 1 : Autorisation & Connexion permanente à la régie
    // ===================================================================

    async function authorizeAndConnect() {
        setStatus('Initialisation des périphériques…');

        try {
            await ensureStreams();
        } catch (err) {
            console.error('Erreur capture:', err);
            if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
                showBlocking();
            } else {
                setStatus('Erreur : ' + err.message);
            }
            return;
        }

        // Masquer la modale d'autorisation
        document.getElementById('permissionModal').style.display = 'none';

        // Attendre le chargement des serveurs TURN, puis connecter PeerJS
        await iceReady;
        connectToHost();
    }

    function connectToHost() {
        setStatus('Connexion au serveur PeerJS…');

        if (peer) {
            try { peer.destroy(); } catch (_) {}
            peer = null;
        }

        peer = new Peer({ config: ICE_CONFIG });

        peer.on('open', function () {
            setStatus('Connexion à la régie (Le Pire Dev)…');

            // Canal de contrôle (DataConnection)
            dataConn = peer.connect(HOST_ID, { reliable: true });

            // Diagnostic : si le canal n'est pas ouvert après 12 s, le réseau bloque la connexion directe
            var openCheck = dataConn;
            setTimeout(function () {
                if (openCheck === dataConn && !openCheck.open) {
                    showNetWarn(TURN_USERNAME
                        ? "Connexion à l'hôte impossible. Vérifiez que l'hôte est ouvert, puis rechargez."
                        : 'Connexion réseau impossible : identifiants ExpressTURN manquants (TURN_USERNAME / TURN_PASSWORD).');
                }
            }, 12000);

            dataConn.on('open', function () {
                isConnectedToHost = true;
                // Informer l'hôte de l'état actuel (pas encore démarré)
                sendStatus();
            });

            dataConn.on('data', function (data) {
                if (data === 'host_ready' || (data && data.type === 'host_ready')) {
                    showScreen2();
                } else if (data === 'hangup' || (data && data.type === 'hangup')) {
                    handleRemoteHangup();
                } else if (data === 'eject' || (data && data.type === 'eject')) {
                    location.reload();
                }
            });

            dataConn.on('close', function () {
                isConnectedToHost = false;
                showScreen1();
            });

            dataConn.on('error', function (err) {
                console.error('DataConn error:', err);
            });

            // --- Appel 1 : Caméra + Micro ---
            var cameraCall = peer.call(HOST_ID, cameraStream, {
                metadata: { type: 'camera', state: clientState }
            });

            cameraCall.on('stream', function (remoteStream) {
                document.getElementById('remoteVideo').srcObject = remoteStream;
            });

            // --- Appel 2 : Partage d'écran ---
            peer.call(HOST_ID, screenStream, {
                metadata: { type: 'screen' }
            });
        });

        peer.on('error', function (err) {
            console.error('Peer error:', err);
            if (err.type === 'peer-unavailable') {
                setStatus("La régie hôte n'est pas encore prête. Nouvelle tentative automatique…");
                setTimeout(connectToHost, 3000);
            } else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(err.type) !== -1) {
                // Perte de connexion au serveur PeerJS : nouvelle tentative automatique
                setStatus('Connexion au serveur perdue — nouvelle tentative…');
                setTimeout(connectToHost, 3000);
            } else {
                setStatus('Erreur de connexion : ' + err.message);
            }
        });
    }

    function sendStatus() {
        if (dataConn && dataConn.open) {
            dataConn.send({
                type: 'status',
                state: clientState,
                started: clientState === 'live'
            });
        }
    }

    // ===================================================================
    //  Étape 2 : Clic sur "Se connecter" -> Attente de validation Hôte ("Prêt")
    // ===================================================================

    function startCall() {
        showWaitingHost();
        sendStatus();
    }

    // ===================================================================
    //  Raccrochage par l'Hôte
    // ===================================================================

    function handleRemoteHangup() {
        showScreen1();
        sendStatus();
    }

    // Tentative d'auto-démarrage si l'environnement le permet sans clic
    window.addEventListener('DOMContentLoaded', function () {
        // Tente de vérifier si on peut capturer automatiquement
        if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
            // Reste affiché pour le geste utilisateur sécurisé
        }
    });
