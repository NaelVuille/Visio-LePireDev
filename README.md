# Le Pire Dev — Visio

Application web statique pour animer l'activité **« Le Pire Dev »** à distance : un **candidat** est filmé et partage son écran, tandis qu'une **régie hôte** reçoit les deux flux en direct et décide du moment où la session démarre.

Tout passe par **WebRTC** (via [PeerJS](https://peerjs.com/)), c'est-à-dire en pair-à-pair : il n'y a **aucun serveur applicatif** à héberger. Seuls un serveur de signalisation PeerJS public, des serveurs STUN et un serveur TURN (ExpressTURN) sont utilisés pour établir la connexion.

---

## Sommaire

- [Fonctionnement](#fonctionnement)
- [Les deux pages](#les-deux-pages)
- [Séquence d'une session](#séquence-dune-session)
- [Structure du projet](#structure-du-projet)
- [Lancer en local](#lancer-en-local)
- [Déploiement](#déploiement)
- [Configuration réseau (STUN / TURN)](#configuration-réseau-stun--turn)
- [Raccourci F2](#raccourci-f2)
- [Dépannage](#dépannage)
- [Limites connues](#limites-connues)

---

## Fonctionnement

### Les flux

Chaque poste ouvre jusqu'à **deux flux** :

| Flux | Contenu | Émis par | Reçu par |
|---|---|---|---|
| Caméra | Webcam + microphone | Candidat | Régie |
| Écran | Partage d'écran complet (+ audio système si le navigateur le permet) | Candidat | Régie |
| Caméra régie | Webcam + micro de l'animateur | Régie | Candidat (petit aperçu) |

En plus des flux média, un **canal de données** (`DataConnection` PeerJS, fiable) transporte les messages de contrôle :

| Message | Sens | Effet |
|---|---|---|
| `status` | Candidat → Régie | Le candidat annonce son état (`idle`, `waiting_host`, `live`) |
| `host_ready` | Régie → Candidat | Débloque l'écran d'attente et lance le direct chez le candidat |
| `hangup` | Régie → Candidat | Renvoie le candidat sur l'écran d'accueil (fin de passage) |
| `eject` | Régie → Candidat | Recharge complètement la page du candidat (changement de poste) |

### Les états

Le candidat et la régie partagent la même machine à états :

- **`idle`** — le candidat vient d'ouvrir la page, ses flux sont déjà envoyés à la régie.
  Côté régie : écran **Pré-session** (l'animateur voit le candidat sans être encore en direct).
  Côté candidat : écran d'accueil avec le bouton **« Se connecter »**.
- **`waiting_host`** — le candidat a cliqué sur « Se connecter » et attend.
  Côté candidat : spinner « Connexion en cours… ».
  Côté régie : badge **CONNEXION DEMANDÉE** + bouton **« ✅ Prêt »**.
- **`live`** — la régie a cliqué sur « Prêt » : le candidat passe sur la vue plein écran du retour régie, la régie passe sur la vue directe.

La régie peut basculer entre deux dispositions en direct : **caméra en grand** ou **écran en grand** (l'autre flux est affiché en incrustation). Le bouton « Raccrocher / Candidat suivant » renvoie le candidat à l'écran d'accueil **sans couper les flux**, ce qui permet d'enchaîner plusieurs passages.

### Autorisations navigateur

Le partage d'écran (`getDisplayMedia`) ne peut être déclenché que par un geste utilisateur : c'est le rôle de la **modale d'autorisation initiale**. Si l'utilisateur refuse le partage d'écran, un **écran bloquant** s'affiche et l'activité ne peut pas continuer.

Si la caméra ou le micro est absent/refusé, l'application ne bloque pas : elle **bascule automatiquement** sur des flux factices (image noire + piste audio muette).

### Reconnexion

- La régie qui perd le serveur PeerJS se reconnecte automatiquement (toutes les 3 s).
- Le candidat qui n'arrive pas à joindre la régie (régie pas encore ouverte) réessaie toutes les 3 s.
- Un bandeau de diagnostic s'affiche en haut de l'écran si une connexion n'aboutit pas dans les 12 s (régie fermée, TURN manquant, réseau trop restrictif).

---

## Les deux pages

| Page | URL | Rôle |
|---|---|---|
| **Candidat** | `/index.html` | Accueil + plein écran du retour régie, avec la caméra locale en incrustation |
| **Régie hôte** | `/hote/index.html` | Surveillance pré-session, validation « Prêt », pilotage du direct |

Les deux pages se retrouvent via un identifiant PeerJS fixe, `HOST_ID` (défini dans `app.js` et `hote/app.js`) : l'hôte **prend** cet identifiant, les candidats **l'appellent**. Une seule régie peut donc être active à la fois sur ce `HOST_ID`.

---

## Séquence d'une session

```
Candidat                                Régie hôte
   |                                        |
   |  ouvre la page                         |  ouvre /hote/, "prend" HOST_ID
   |  autorise caméra + micro + écran       |
   |------ DataConnection ----------------->|
   |------ appel "camera" ----------------->|  aperçu pré-session
   |------ appel "screen" ----------------->|  aperçu pré-session
   |------ status{idle} ------------------->|  écran PRÉ-SESSION
   |                                        |
   |  clic « Se connecter »                 |
   |------ status{waiting_host} ----------->|  badge CONNEXION DEMANDÉE
   |   spinner côté candidat                |  bouton « ✅ Prêt » visible
   |                                        |
   |<----- host_ready ----------------------|  clic « Prêt »
   |  écran direct                          |  écran direct
   |                                        |
   |<----- hangup --------------------------|  clic « Raccrocher »
   |  retour accueil (flux maintenus)       |  retour pré-session
```

---

## Structure du projet

```
.
├── index.html                  # Page candidat
├── style.css                   # Styles de la page candidat
├── app.js                      # Logique candidat (PeerJS, flux, états)
├── hote/
│   ├── index.html              # Page régie hôte
│   ├── style.css               # Styles de la régie
│   └── app.js                  # Logique régie (réception, modes, contrôles)
└── .github/workflows/
    └── deploy-pages.yml        # Publication GitHub Pages
```

Aucune dépendance à installer, aucun build : ce sont des fichiers statiques, et PeerJS est chargé depuis le CDN unpkg.

---

## Lancer en local

Le partage d'écran n'est autorisé par le navigateur qu'en **HTTPS** ou sur **`localhost`**. Il faut donc servir les fichiers via HTTP, et non les ouvrir avec `file://` :

```bash
python3 -m http.server 8000
```

Puis :

- candidat : <http://localhost:8000/>
- régie : <http://localhost:8000/hote/>

Pour tester sur deux machines du même réseau local avec une IP, il faut du HTTPS (ou un tunnel type ngrok / Cloudflare Tunnel), sinon `getDisplayMedia` est refusé.

---

## Déploiement

Le workflow `.github/workflows/deploy-pages.yml` publie automatiquement le site sur **GitHub Pages** à chaque push sur `main` (ou manuellement via *workflow_dispatch*). Il copie les fichiers de la racine et du dossier `hote/` dans `dist/`, puis déploie ce dossier.

Une fois Pages activé (*Settings → Pages → Source : GitHub Actions*), les URLs sont :

- `https://<compte>.github.io/Visio-LePireDev/` — candidat
- `https://<compte>.github.io/Visio-LePireDev/hote/` — régie

---

## Configuration réseau (STUN / TURN)

La connexion directe entre deux postes échoue sur la plupart des réseaux d'entreprise, car NAT et pare-feu bloquent le P2P. Un serveur **TURN** relaie alors le trafic.

Les constantes sont en haut de `app.js` **et** de `hote/app.js` (les deux doivent être identiques) :

```js
const HOST_ID       = 'ETML-LePireDev-2026';
const TURN_USERNAME = '...';
const TURN_PASSWORD = '...';
```

Pour utiliser votre propre serveur :

1. Créez un compte gratuit sur <https://www.expressturn.com/> (sans carte bancaire) ou hébergez coturn.
2. Remplacez `TURN_USERNAME` / `TURN_PASSWORD` dans les **deux** fichiers, ainsi que les URLs `turn:` si besoin.
3. Si vous laissez les identifiants vides, l'application fonctionne quand même, mais uniquement entre deux postes capables de se joindre en direct.

> ⚠️ Les identifiants TURN sont actuellement écrits **en clair** dans le code source public. N'importe qui peut les lire et consommer le quota du compte. Pour un usage durable, générez des identifiants éphémères côté serveur (petit Worker/proxy) et ne les committez pas.

---

## Raccourci F2

Sur les deux pages, **F2** active un mode **sans caméra ni micro** : des flux factices (image noire + audio muet) sont utilisés à la place. Pratique pour tester la régie ou animer depuis une machine sans webcam. Sur la page candidat, F2 depuis la modale d'autorisation lance directement la connexion (le partage d'écran, lui, reste obligatoire).

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Bandeau « Connexion à l'hôte impossible » | Régie pas encore ouverte, ou réseau bloquant le P2P | Ouvrir `/hote/` en premier, recharger les deux pages |
| Bandeau « identifiants ExpressTURN manquants » | `TURN_USERNAME` / `TURN_PASSWORD` vides | Renseigner les constantes dans les deux `app.js` |
| Écran « Partage d'écran obligatoire » | Partage refusé ou arrêté via l'UI du navigateur | Recharger la page et réautoriser |
| « ID régie déjà occupé » | Une autre régie utilise déjà `HOST_ID` | Fermer l'autre onglet, ou changer `HOST_ID` dans les deux fichiers |
| « Caméra/micro non détecté » côté régie | Pas de webcam, permission refusée | Appuyer sur **F2** |
| Pas de son chez le candidat | Le son de la régie est coupé sur l'écran d'attente (volontaire) | Il est réactivé automatiquement en direct |

---

## Limites connues

- **Un seul candidat à la fois** : toute nouvelle connexion remplace la précédente, et le `HOST_ID` est unique (pas de multi-régie).
- **Pas de secours si PeerJS est indisponible** : le serveur de signalisation par défaut est celui de PeerJS.
- **Identifiants TURN en clair** dans le dépôt (voir ci-dessus).
- **Pas de test automatisé** : la vérification se fait manuellement avec deux onglets ou deux machines.
