// Dictionnaire des types de voies (nature_voie)
export const NATURE_VOIE: Record<string, string> = {
  'ALL': 'Allée',
  'AV': 'Avenue',
  'BD': 'Boulevard',
  'CAR': 'Carrefour',
  'CHE': 'Chemin',
  'CHS': 'Chaussée',
  'CITE': 'Cité',
  'COR': 'Corniche',
  'CRS': 'Cours',
  'DOM': 'Domaine',
  'DSC': 'Descente',
  'ECA': 'Écart',
  'ESP': 'Esplanade',
  'FG': 'Faubourg',
  'GR': 'Grande Rue',
  'HAM': 'Hameau',
  'HLE': 'Halle',
  'IMP': 'Impasse',
  'LD': 'Lieu-dit',
  'LOT': 'Lotissement',
  'MAR': 'Marché',
  'MTE': 'Montée',
  'PAS': 'Passage',
  'PL': 'Place',
  'PLN': 'Plaine',
  'PLT': 'Plateau',
  'PRO': 'Promenade',
  'PRV': 'Parvis',
  'QUA': 'Quartier',
  'QUAI': 'Quai',
  'RES': 'Résidence',
  'RLE': 'Ruelle',
  'ROC': 'Rocade',
  'RPT': 'Rond-point',
  'RTE': 'Route',
  'RUE': 'Rue',
  'SEN': 'Sente',
  'SQ': 'Square',
  'TPL': 'Terre-plein',
  'TRA': 'Traverse',
  'VLA': 'Villa',
  'VLGE': 'Village',
  'VOI': 'Voie',
  'ZA': 'Zone d\'Activité',
  'ZAC': 'Zone d\'Aménagement Concerté',
  'ZAD': 'Zone d\'Aménagement Différé',
  'ZI': 'Zone Industrielle',
  'ZUP': 'Zone à Urbaniser en Priorité',
};

// Dictionnaire des codes droit (type de propriété)
export const CODE_DROIT: Record<string, string> = {
  'P': 'Propriétaire',
  'U': 'Usufruitier',
  'N': 'Nu-propriétaire',
  'B': 'Bailleur à construction',
  'R': 'Preneur à construction',
  'F': 'Foncier',
  'T': 'Ténuyer',
  'D': 'Domanier',
  'V': 'Bailleur d\'emphytéose',
  'W': 'Preneur d\'emphytéose',
  'A': 'Locataire-attributaire',
  'E': 'Emphytéote',
  'K': 'Antichrésiste',
  'L': 'Fonctionnaire logé',
  'G': 'Gérant, mandataire, gestionnaire',
  'S': 'Syndic de copropriété',
  'H': 'Associé dans une société en transparence fiscale',
  'O': 'Autorisation d\'occupation temporaire',
  'J': 'Jeune agriculteur',
  'Q': 'Gestionnaire taxe bureaux',
  'X': 'La Poste occupant et propriétaire',
  'Y': 'La Poste occupant et non propriétaire',
  'C': 'Fiduciaire',
  'M': 'Occupant d\'une parcelle appartenant au département',
  'Z': 'Gestionnaire d\'un bien de l\'État',
  'I': 'Occupant temporaire du domaine public',
};

// Dictionnaire des groupes de personnes
export const GROUPE_PERSONNE: Record<string, string> = {
  '0': 'Groupement de droit privé non doté de la personnalité morale (société créée de fait)',
  '1': 'Personne physique',
  '2': 'Personne morale (PM) de droit privé avec forme juridique',
  '3': 'PM de droit public soumise au droit commercial',
  '4': 'PM de droit public soumise à un statut particulier',
  '5': 'Établissement public national à caractère scientifique, culturel ou professionnel',
  '6': 'PM comprenant une entité publique (État, collectivité territoriale, établissement public)',
  '7': 'PM de droit privé sans forme juridique',
  '8': 'Société civile de droit privé',
  '9': 'Groupement de droit public non doté de la personnalité morale',
};

// Dictionnaire des formes juridiques (principales)
export const FORME_JURIDIQUE: Record<string, string> = {
  // Personnes physiques
  '': 'Non spécifié',

  // Entreprises individuelles
  'EI': 'Entrepreneur Individuel',
  'EIRL': 'Entrepreneur Individuel à Responsabilité Limitée',

  // Sociétés commerciales
  'SA': 'Société Anonyme',
  'SAS': 'Société par Actions Simplifiée',
  'SASU': 'Société par Actions Simplifiée Unipersonnelle',
  'SARL': 'Société à Responsabilité Limitée',
  'EURL': 'Entreprise Unipersonnelle à Responsabilité Limitée',
  'SNC': 'Société en Nom Collectif',
  'SCS': 'Société en Commandite Simple',
  'SCA': 'Société en Commandite par Actions',
  'SE': 'Société Européenne',

  // Sociétés civiles
  'SCI': 'Société Civile Immobilière',
  'SCPI': 'Société Civile de Placement Immobilier',
  'SCP': 'Société Civile Professionnelle',
  'SCM': 'Société Civile de Moyens',
  'SC': 'Société Civile',
  'SCEA': 'Société Civile d\'Exploitation Agricole',
  'GAEC': 'Groupement Agricole d\'Exploitation en Commun',
  'EARL': 'Exploitation Agricole à Responsabilité Limitée',

  // Coopératives et mutuelles
  'SCOP': 'Société Coopérative et Participative',
  'SCIC': 'Société Coopérative d\'Intérêt Collectif',
  'COOP': 'Coopérative',

  // Associations et fondations
  'ASSO': 'Association',
  'FOND': 'Fondation',

  // Secteur public
  'EPIC': 'Établissement Public Industriel et Commercial',
  'EPA': 'Établissement Public Administratif',
  'EPCI': 'Établissement Public de Coopération Intercommunale',
  'SEM': 'Société d\'Économie Mixte',
  'SPL': 'Société Publique Locale',
  'GIP': 'Groupement d\'Intérêt Public',

  // Autres
  'GIE': 'Groupement d\'Intérêt Économique',
  'SEL': 'Société d\'Exercice Libéral',
  'SELARL': 'Société d\'Exercice Libéral à Responsabilité Limitée',
  'SELAS': 'Société d\'Exercice Libéral par Actions Simplifiée',
  'SEP': 'Société en Participation',
  'INDIV': 'Indivision',
  'COPRO': 'Copropriété',
  'SYND': 'Syndicat',
};

// Fonction pour décoder le type de voie
export function decodeNatureVoie(code: string): string {
  if (!code) return '';
  const normalized = code.trim().toUpperCase();
  return NATURE_VOIE[normalized] || normalized;
}

// Fonction pour décoder le code droit
export function decodeCodeDroit(code: string): string {
  if (!code) return '';
  const normalized = code.trim().toUpperCase();
  return CODE_DROIT[normalized] || normalized;
}

// Fonction pour décoder le groupe personne
export function decodeGroupePersonne(code: string): string {
  if (!code) return '';
  const normalized = code.trim();
  return GROUPE_PERSONNE[normalized] || `Groupe ${normalized}`;
}

// Fonction pour décoder la forme juridique
export function decodeFormeJuridique(code: string): string {
  if (!code) return '';
  const normalized = code.trim().toUpperCase();
  return FORME_JURIDIQUE[normalized] || normalized;
}

// Fonction pour normaliser un nom de voie (capitalisation)
export function normalizeNomVoie(nom: string): string {
  if (!nom) return '';

  // Liste de mots à garder en minuscule (articles, prépositions)
  const lowercase = ['de', 'du', 'des', 'la', 'le', 'les', 'l', 'à', 'au', 'aux', 'en', 'et', 'd', 'sur', 'sous'];

  return nom
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((word, index) => {
      if (index === 0) return capitalizeFirst(word);
      if (lowercase.includes(word.toLowerCase())) return word.toLowerCase();
      return capitalizeFirst(word);
    })
    .join('');
}

// Capitalise la première lettre
function capitalizeFirst(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Fonction pour construire une adresse complète formatée
export function formatAdresseComplete(
  numero: string,
  indiceRepetition: string,
  natureVoie: string,
  nomVoie: string,
  commune: string,
  departement: string
): string {
  const parts: string[] = [];

  // Numéro et indice
  if (numero && numero !== '0' && numero !== '00000') {
    let numPart = parseInt(numero).toString();
    if (indiceRepetition) {
      numPart += ` ${indiceRepetition.toLowerCase()}`;
    }
    parts.push(numPart);
  }

  // Type de voie décodé
  const typeVoie = decodeNatureVoie(natureVoie);
  if (typeVoie) parts.push(typeVoie);

  // Nom de voie normalisé
  const voie = normalizeNomVoie(nomVoie);
  if (voie) parts.push(voie);

  // Commune et département
  const location = [commune, departement].filter(Boolean).join(' ');
  if (location) parts.push(`- ${location}`);

  return parts.join(' ');
}
