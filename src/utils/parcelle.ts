/**
 * Identifiant unique de parcelle (IDU) - source unique de verite.
 *
 * L'IDU est la seule cle qui relie les quatre referentiels du systeme :
 *   - cadastre_geo.parcelles_cadastre.idu          varchar(20)
 *   - bdnb_<millesime>.parcelle.parcelle_id        varchar(14)
 *   - bdnb_<millesime>.rel_batiment_groupe_parcelle.parcelle_id
 *   - dvf.mutations.id_parcelle                    text
 *
 * Composition : code_departement + code_commune(3) + prefixe(3) + section(2) + numero(4)
 *
 * En metropole le code departement tient sur 2 caracteres, l'IDU fait donc 14
 * caracteres. Dans les DOM il tient sur 3 caracteres (971 a 976) et l'IDU fait
 * 15 caracteres. `parcelles_cadastre.idu` etant en varchar(20) accepte les deux,
 * mais `bdnb.parcelle.parcelle_id` est en varchar(14) et son
 * `code_departement_insee` en varchar(2) : la BDNB ne peut structurellement pas
 * porter de parcelle d'outre-mer. On expose donc les deux longueurs et on laisse
 * l'appelant savoir quelles sources sont interrogeables (cf. isDomIdu).
 *
 * Cette fonction remplace la reconstruction qui vivait cote frontend
 * (app/api/cadastre/search/route.ts) : le backend est le seul endroit qui
 * connait le format des colonnes sources, c'est donc a lui de produire la cle.
 */

/** Longueur d'un IDU metropolitain. */
export const IDU_LENGTH_METROPOLE = 14;

/** Longueur d'un IDU d'outre-mer (departement sur 3 caracteres). */
export const IDU_LENGTH_DOM = 15;

export interface IduParts {
  departement: string;
  code_commune: string;
  prefixe: string | null;
  section: string;
  numero_plan: string;
}

/**
 * Normalise un code departement.
 * Metropole : 2 caracteres, zero-paddes ('1' -> '01').
 * Corse     : '2A' / '2B' conserves tels quels.
 * DOM       : 3 caracteres ('971' a '976') conserves tels quels.
 */
function normalizeDepartement(raw: string): string | null {
  const dep = (raw || '').trim().toUpperCase();
  if (!dep) return null;

  // DOM : 3 chiffres commencant par 97 ou 98
  if (/^9[78]\d$/.test(dep)) return dep;

  // Corse
  if (dep === '2A' || dep === '2B') return dep;

  // Metropole : 1 ou 2 chiffres
  if (/^\d{1,2}$/.test(dep)) return dep.padStart(2, '0');

  return null;
}

/**
 * Construit l'IDU a partir des colonnes de proprietaires_geo.
 * Retourne null si une composante indispensable manque : mieux vaut ne pas
 * enrichir que d'enrichir la mauvaise parcelle. Une cle tronquee ou mal paddee
 * apparie silencieusement une parcelle voisine, ce qui produirait un prix de
 * vente faux affiche comme certain.
 */
export function buildIdu(parts: IduParts): string | null {
  const departement = normalizeDepartement(parts.departement);
  if (!departement) return null;

  const codeCommune = (parts.code_commune || '').trim();
  const section = (parts.section || '').trim().toUpperCase();
  const numero = (parts.numero_plan || '').trim();

  // Ces trois composantes ne peuvent pas etre devinees.
  if (!codeCommune || !section || !numero) return null;

  // Le code commune est sur 3 caracteres. Certaines sources le stockent deja
  // concatene au departement (5 caracteres, code INSEE complet) : on retire
  // alors le prefixe departement pour ne pas le compter deux fois.
  let commune = codeCommune;
  if (commune.length === 5 && commune.startsWith(departement)) {
    commune = commune.slice(departement.length);
  }
  if (commune.length > 3) return null;
  commune = commune.padStart(3, '0');

  // Le prefixe (ex-commune absorbee) vaut '000' quand il n'y en a pas.
  const rawPrefixe = (parts.prefixe || '').trim();
  const prefixe = rawPrefixe ? rawPrefixe.padStart(3, '0') : '000';
  if (prefixe.length > 3) return null;

  if (section.length > 2) return null;
  const sectionPadded = section.padStart(2, '0');

  if (numero.length > 4) return null;
  const numeroPadded = numero.padStart(4, '0');

  const idu = `${departement}${commune}${prefixe}${sectionPadded}${numeroPadded}`;

  // Garde-fou : toute longueur inattendue signale une donnee source hors format.
  if (idu.length !== IDU_LENGTH_METROPOLE && idu.length !== IDU_LENGTH_DOM) {
    return null;
  }

  return idu;
}

/**
 * True si l'IDU designe une parcelle d'outre-mer.
 * Les tables BDNB (parcelle_id varchar(14), code_departement_insee varchar(2))
 * ne peuvent pas contenir ces parcelles : l'enrichissement batiment et surface
 * geometrique est donc indisponible, sans que ce soit une erreur.
 */
export function isDomIdu(idu: string): boolean {
  return idu.length === IDU_LENGTH_DOM;
}

/**
 * Decoupe un IDU en ses composantes. Utile pour reconstruire une reference
 * lisible par un humain a partir de la seule cle.
 */
export function parseIdu(idu: string): IduParts | null {
  if (idu.length !== IDU_LENGTH_METROPOLE && idu.length !== IDU_LENGTH_DOM) {
    return null;
  }
  const depLength = idu.length === IDU_LENGTH_DOM ? 3 : 2;
  return {
    departement: idu.slice(0, depLength),
    code_commune: idu.slice(depLength, depLength + 3),
    prefixe: idu.slice(depLength + 3, depLength + 6),
    section: idu.slice(depLength + 6, depLength + 8),
    numero_plan: idu.slice(depLength + 8),
  };
}

/**
 * Reference cadastrale lisible (ex: "75 056 000 AB 0123").
 * Ne remplace pas l'IDU : sert uniquement a l'affichage.
 */
export function formatReferenceLisible(parts: IduParts): string {
  return [
    parts.departement,
    parts.code_commune,
    parts.prefixe || '000',
    parts.section,
    parts.numero_plan,
  ]
    .filter(Boolean)
    .join(' ');
}
