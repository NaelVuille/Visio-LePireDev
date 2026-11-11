// Cloudflare Worker — génère des identifiants TURN temporaires (24 h) pour "Le Pire Dev".
// Le token secret reste côté Cloudflare (variables du Worker), jamais dans les pages GitHub.
//
// Variables à définir dans le Worker (Settings > Variables and Secrets) :
//   TURN_KEY_ID     (texte)   -> "Key ID" du TURN Server Cloudflare
//   TURN_API_TOKEN  (SECRET)  -> "API Token" du TURN Server Cloudflare

const ALLOWED_ORIGINS = [
  'https://naelvuille.github.io',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);

    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Refuse les appels venant d'autres sites (protège votre quota)
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }), // 24 h : couvre une journée de 12 h
      }
    );

    return new Response(await r.text(), {
      status: r.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
