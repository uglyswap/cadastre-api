// Types pour les données cadastrales
export interface LocalRaw {
  département: string;
  code_direction: string;
  code_commune: string;
  nom_de_la_commune: string;
  préfixe: string | null;
  section: string;
  "n°_plan": string;
  bâtiment: string;
  entrée: string;
  niveau: string;
  porte: string;
  "n°_voirie": string;
  indice_de_répétition: string;
  code_voie_majic: string;
  code_voie_rivoli: string;
  nature_voie: string;
  nom_voie: string;
  code_droit: string;
  "n°_majic": string;
  "n°_siren": string;
  groupe_personne: string;
  forme_juridique: string;
  forme_juridique_abrégée: string;
  dénomination: string;
}

// Types pour les réponses API formatées
export interface Adresse {
  numero: string;
  indice_repetition: string;
  type_voie: string;
  nom_voie: string;
  code_postal: string;
  commune: string;
  departement: string;
  adresse_complete: string;
}

export interface ReferenceCadastrale {
  departement: string;
  code_commune: string;
  prefixe: string | null;
  section: string;
  numero_plan: string;
  reference_complete: string;
}

export interface LocalisationLocal {
  batiment: string;
  entree: string;
  niveau: string;
  porte: string;
}

export interface Proprietaire {
  siren: string;
  denomination: string;
  forme_juridique: string;
  forme_juridique_code: string;
  groupe: string;
  groupe_code: string;
  type_droit: string;
  type_droit_code: string;
}

export interface Propriete {
  adresse: Adresse;
  reference_cadastrale: ReferenceCadastrale;
  localisation: LocalisationLocal;
  proprietaire: Proprietaire;
}

// Propriété groupée par adresse (avec plusieurs lots/références cadastrales)
export interface ProprieteGroupee {
  adresse: Adresse;
  references_cadastrales: ReferenceCadastrale[];
  localisations: LocalisationLocal[];
  nombre_lots: number;
}

// Types pour l'enrichissement API Entreprises
export interface Dirigeant {
  nom: string;
  prenoms: string;
  qualite: string;
  type: "personne_physique" | "personne_morale";
  annee_naissance?: string;
  siren?: string; // Pour les PM
  denomination?: string; // Pour les PM
}

// Bénéficiaire effectif (personne physique finale après résolution de la chaîne)
export interface BeneficiaireEffectif {
  nom: string;
  prenoms: string;
  qualite: string;
  annee_naissance?: string;
  // Chaîne de contrôle: liste des sociétés intermédiaires pour arriver à cette personne
  chaine_controle: Array<{
    siren: string;
    denomination: string;
    qualite: string; // Rôle dans la société précédente
  }>;
}

export interface SiegeEntreprise {
  adresse: string;
  code_postal: string;
  commune: string;
  latitude?: string;
  longitude?: string;
}

export interface EntrepriseEnrichie {
  siren: string;
  nom_complet: string;
  nom_raison_sociale: string;
  sigle: string | null;
  nature_juridique: string;
  date_creation: string;
  etat_administratif: string;
  categorie_entreprise: string;
  tranche_effectif: string;
  siege: SiegeEntreprise;
  dirigeants: Dirigeant[];
  // Bénéficiaires effectifs: personnes physiques finales après résolution des chaînes de PM
  beneficiaires_effectifs: BeneficiaireEffectif[];
  nombre_etablissements: number;
}

// Types pour les réponses API
export interface SearchByAddressResponse {
  success: boolean;
  query: {
    adresse: string;
    departement?: string;
  };
  resultats: Array<{
    proprietaire: Proprietaire;
    entreprise?: EntrepriseEnrichie;
    proprietes: ProprieteGroupee[];
    nombre_adresses: number;
    nombre_lots: number;
  }>;
  total_proprietaires: number;
  total_lots: number;
}

export interface SearchByOwnerResponse {
  success: boolean;
  query: {
    siren?: string;
    denomination?: string;
  };
  proprietaire?: Proprietaire;
  entreprise?: EntrepriseEnrichie;
  proprietes: ProprieteGroupee[];
  nombre_adresses: number;
  nombre_lots: number;
  departements_concernes: string[];
}

// Types pour l'authentification
export interface ApiKey {
  key: string;
  name: string;
  created_at: Date;
  is_active: boolean;
  rate_limit?: number; // requêtes par minute
  monthly_quota?: number; // résultats par mois
  current_month_usage?: number;
}

// Types pour les erreurs
export interface ApiError {
  success: false;
  error: string;
  code: string;
  details?: string;
}
