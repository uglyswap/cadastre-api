/**
 * Identifiant unique de parcelle (IDU) - source unique de verite.
 *
 * L'IDU est la seule cle qui relie les quatre referentiels du systeme :
 *   - cadastre_geo.parcelles_cadastre.idu          varchar(20)
 *   - bdnb_<millesime>.parcelle.parcelle_id        varchar(14)
 *   - bdnb_<millesime>.rel_batiment_groupe_parcelle.parcelle_id
 *   - dvf.mutations.id_parcelle                    text
 *
 * Composition : code_departement + code_commune + prefixe(3) + section(2) + numero(4)
 *
 * L'IDU fait TOUJOURS 14 caracteres. Le code INSEE d'une commune en fait 5, qui
 * se repartissent differemment selon le territoire :
 *   - metropole  : departement sur 2, commune sur 3  ('75'  + '056')
 *   - outre-mer  : departement sur 3, commune sur 2  ('971' + '01')
 *
 * Padder la commune sur 3 dans les deux cas produisait un IDU de 15 caracteres
 * en outre-mer, qui ne correspondait a aucune ligne d'aucun referentiel.
 *
 * `bdnb.parcelle.code_departement_insee` est en varchar(2) et ne peut pas porter
 * '971' : l'enrichissement batiment est donc indisponible outre-mer, sans que ce
 * soit une erreur (cf. isDomIdu). Les ventes DVF et la contenance cadastrale y
 * restent accessibles.
 *
 * Cette fonction remplace la reconstruction qui vivait cote frontend
 * (app/api/cadastre/search/route.ts) : le backend est le seul endroit qui
 * connait le format des colonnes sources, c'est donc a lui de produire la cle.
 */

/**
 * Longueur d'un IDU, invariable.
 *
 * 14 caracteres en metropole comme en outre-mer : le departement gagne un
 * caractere outre-mer (971) mais la commune en perd un (01 au lieu de 056).
 */
export const IDU_LENGTH = 14;

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

  // L'IDU fait TOUJOURS 14 caracteres, y compris en outre-mer.
  //
  // Le code INSEE d'une commune fait 5 caracteres. En metropole il se decompose
  // en departement sur 2 et commune sur 3 ('75' + '056'). En outre-mer le
  // departement occupe 3 caracteres et la commune n'en occupe donc plus que 2
  // ('971' + '01'). Padder la commune sur 3 dans les deux cas produisait un IDU
  // de 15 caracteres pour les DOM, qui ne correspondait a aucune ligne des
  // referentiels : ni dvf.mutations.id_parcelle, ni bdnb.parcelle.parcelle_id
  // (varchar(14)), ni parcelles_cadastre.idu.
  const longueurCommune = departement.length === 3 ? 2 : 3;

  let commune = codeCommune;
  // Certaines sources stockent deja le code INSEE complet sur 5 caracteres :
  // on retire alors le prefixe departement pour ne pas le compter deux fois.
  if (commune.length === 5 && commune.startsWith(departement)) {
    commune = commune.slice(departement.length);
  }
  if (commune.length > longueurCommune) return null;
  commune = commune.padStart(longueurCommune, '0');

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
  // Mieux vaut ne pas enrichir que d'apparier silencieusement la mauvaise
  // parcelle, ce qui afficherait un prix de vente faux comme s'il etait certain.
  if (idu.length !== IDU_LENGTH) {
    return null;
  }

  return idu;
}

/**
 * True si l'IDU designe une parcelle d'outre-mer.
 *
 * `bdnb.parcelle.code_departement_insee` est en varchar(2) et ne peut donc pas
 * porter '971' : l'enrichissement batiment et surface geometrique est
 * indisponible pour ces parcelles, sans que ce soit une erreur. Les ventes DVF
 * et la contenance cadastrale, elles, restent disponibles.
 */
export function isDomIdu(idu: string): boolean {
  return /^9[78]/.test(idu);
}

/**
 * Decoupe un IDU en ses composantes. Utile pour reconstruire une reference
 * lisible par un humain a partir de la seule cle.
 */
export function parseIdu(idu: string): IduParts | null {
  if (idu.length !== IDU_LENGTH) return null;

  // Outre-mer : departement sur 3, commune sur 2. Metropole : 2 et 3.
  const depLength = /^9[78]/.test(idu) ? 3 : 2;
  const communeLength = depLength === 3 ? 2 : 3;

  return {
    departement: idu.slice(0, depLength),
    code_commune: idu.slice(depLength, depLength + communeLength),
    prefixe: idu.slice(depLength + communeLength, depLength + communeLength + 3),
    section: idu.slice(depLength + communeLength + 3, depLength + communeLength + 5),
    numero_plan: idu.slice(depLength + communeLength + 5),
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
