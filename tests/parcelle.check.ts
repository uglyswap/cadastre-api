/**
 * Controle du format IDU. Executable par `npx tsx tests/parcelle.check.ts`.
 *
 * Ce depot n'a aucun framework de test : ce fichier est un controle executable
 * minimal, pas un remplacement de suite de tests. Il verifie le point le plus
 * dangereux du calcul de cle : une longueur ou un padding faux apparie
 * silencieusement une parcelle voisine, donc affiche un prix de vente qui
 * n'est pas celui du bien.
 */
import { buildIdu, parseIdu, isDomIdu, IDU_LENGTH } from '../src/utils/parcelle.js';

interface Cas {
  libelle: string;
  parts: Parameters<typeof buildIdu>[0];
  attendu: string | null;
}

const CAS: Cas[] = [
  {
    libelle: 'Metropole, Paris 056 section AB parcelle 12',
    parts: { departement: '75', code_commune: '056', prefixe: null, section: 'AB', numero_plan: '12' },
    attendu: '75056000AB0012',
  },
  {
    libelle: 'Outre-mer, Guadeloupe commune 01',
    parts: { departement: '971', code_commune: '01', prefixe: null, section: 'AB', numero_plan: '12' },
    attendu: '97101000AB0012',
  },
  {
    libelle: 'Outre-mer, code INSEE complet 97101 fourni',
    parts: { departement: '971', code_commune: '97101', prefixe: null, section: 'AB', numero_plan: '12' },
    attendu: '97101000AB0012',
  },
  {
    libelle: 'Corse 2A, section sur 1 caractere',
    parts: { departement: '2A', code_commune: '004', prefixe: null, section: 'C', numero_plan: '1' },
    attendu: '2A0040000C0001',
  },
  {
    libelle: 'Commune absorbee, prefixe 182',
    parts: { departement: '91', code_commune: '228', prefixe: '182', section: 'AR', numero_plan: '39' },
    attendu: '91228182AR0039',
  },
  {
    libelle: 'Section absente : doit refuser plutot que deviner',
    parts: { departement: '75', code_commune: '056', prefixe: null, section: '', numero_plan: '12' },
    attendu: null,
  },
  {
    libelle: 'Numero hors format (5 chiffres) : doit refuser',
    parts: { departement: '75', code_commune: '056', prefixe: null, section: 'AB', numero_plan: '12345' },
    attendu: null,
  },
];

let echecs = 0;

for (const cas of CAS) {
  const obtenu = buildIdu(cas.parts);
  const conforme = obtenu === cas.attendu;
  const longueurOk = obtenu === null || obtenu.length === IDU_LENGTH;

  if (!conforme || !longueurOk) {
    echecs++;
    console.error(
      `ECHEC  ${cas.libelle}\n       attendu=${cas.attendu} obtenu=${obtenu}` +
        (longueurOk ? '' : ` (longueur ${obtenu?.length} au lieu de ${IDU_LENGTH})`)
    );
  } else {
    const suffixe = obtenu ? ` ${obtenu}${isDomIdu(obtenu) ? ' (DOM)' : ''}` : ' refuse';
    console.log(`OK     ${cas.libelle}${suffixe}`);
  }

  // Aller-retour : parseIdu doit reconstituer les composantes.
  if (obtenu) {
    const reparse = parseIdu(obtenu);
    if (!reparse || buildIdu(reparse) !== obtenu) {
      echecs++;
      console.error(`ECHEC  aller-retour parseIdu/buildIdu sur ${obtenu}`);
    }
  }
}

console.log(echecs === 0 ? '\nTous les controles passent.' : `\n${echecs} controle(s) en echec.`);
process.exit(echecs === 0 ? 0 : 1);
