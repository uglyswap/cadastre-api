import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';

/**
 * Comparaison a temps constant de deux chaines, resistante aux timing attacks.
 * Les deux operandes sont hashees a longueur fixe avant comparaison pour ne pas
 * fuiter la longueur de la cle attendue.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Comparer quand meme contre soi-meme pour conserver un temps constant
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Pour l'instant, on utilise une seule API key master
// Plus tard, on pourra ajouter une table api_keys avec rate limiting et quotas
export async function validateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = request.headers['x-api-key'] as string;

  if (!apiKey) {
    reply.code(401).send({
      success: false,
      error: 'API key manquante',
      code: 'MISSING_API_KEY',
      details: 'Fournissez votre clé API dans le header X-API-Key',
    });
    return;
  }

  // Vérification à temps constant contre la master key
  if (!config.auth.masterApiKey || !safeCompare(apiKey, config.auth.masterApiKey)) {
    reply.code(403).send({
      success: false,
      error: 'API key invalide',
      code: 'INVALID_API_KEY',
      details: 'La clé API fournie n\'est pas valide',
    });
    return;
  }

  // Ici, on pourrait ajouter plus tard:
  // - Vérification en base de données
  // - Rate limiting par clé
  // - Quotas mensuels
  // - Logging des requêtes
}

// Décorateur pour les routes protégées
export const authHook = {
  preHandler: validateApiKey,
};
