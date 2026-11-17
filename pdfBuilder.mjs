// pdfBuilder — constructeur du bulletin PDF, AUTO-SUFFISANT et ISOMORPHE
// (navigateur + Deno). N'importe RIEN : reçoit le constructeur jsPDF en paramètre.
// Ce fichier est copié VERBATIM dans l'Edge Function `salareo-pdf` → parité totale
// entre l'aperçu client et le PDF payé généré côté serveur (aucune dérive possible).

// Formatage FR INDÉPENDANT DU RUNTIME : on n'utilise PAS toLocaleString (son
// séparateur de milliers — espace fine insécable U+202F — varie selon l'ICU du
// moteur : OK dans le navigateur, mais rendu « / » par jsPDF côté Deno). On formate
// à la main avec une espace normale → identique navigateur ET serveur.

/** Formate un nombre en euros FR : « 5 763,46 » (espace normale, 2 décimales). */
function formatMontant(value) {
  const num = parseFloat(value) || 0
  const neg = num < 0
  const [intPart, dec] = Math.abs(num).toFixed(2).split('.')
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return (neg ? '-' : '') + withSep + ',' + dec
}

/** Formate un taux FR : 2 décimales min, 3 max (sans zéro final superflu) ; vide si 0. */
function formatTaux(value) {
  const num = parseFloat(value) || 0
  if (num === 0) return ''
  const neg = num < 0
  let s = Math.abs(num).toFixed(3)
  if (s.endsWith('0')) s = Math.abs(num).toFixed(2)
  const [intPart, dec] = s.split('.')
  const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return (neg ? '-' : '') + withSep + ',' + dec
}

const MOIS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
]

/**
 * Convertit une date ISO (YYYY-MM-DD, format natif des <input type="date">)
 * en format français JJ/MM/AAAA. Renvoie la valeur d'origine si elle n'est
 * pas reconnue, et une chaîne vide pour null/undefined.
 */
function formatDateFR(value) {
  if (!value) return ''
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  if (!match) return String(value)
  const [, yyyy, mm, dd] = match
  return `${dd}/${mm}/${yyyy}`
}

/**
 * Date de paiement par défaut : dernier jour OUVRÉ du mois (ni samedi, ni
 * dimanche, ni jour férié légal). Renvoie 'YYYY-MM-DD'.
 */
export function datePaiementParDefaut(year, month) {
  const feries = joursFeries(year)
  const d = new Date(year, month + 1, 0)
  const cle = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  while (d.getDay() === 0 || d.getDay() === 6 || feries.has(cle(d))) d.setDate(d.getDate() - 1)
  return cle(d)
}

/**
 * Date de paiement IMPRIMÉE (R.3243-1 11°), au format JJ/MM/AAAA : celle saisie
 * pour le mois (`data.datePaiement`, ISO), sinon le dernier jour ouvré du mois.
 * Avant le 17/11/2026 tous les modèles imprimaient le dernier jour de la
 * période — parfois un samedi ou un dimanche — qui ne correspondait pas à la
 * date du virement sur le relevé du salarié.
 */
export function datePaiementDe(data, month, year, imprimeeAvant) {
  const saisie = /^\d{4}-\d{2}-\d{2}/.test(String(data?.datePaiement || '')) ? data.datePaiement : null
  if (saisie) return formatDateFR(saisie)
  // Bulletin émis AVANT le champ (instantané sans datePaiement) : on réimprime la
  // date qu'il portait déjà, sinon deux copies du même bulletin remis au
  // salarié ne concorderaient plus — un écart que les organismes repèrent.
  return imprimeeAvant || formatDateFR(datePaiementParDefaut(year, month))
}

/** Mention R.3243-1 15° (rubrique du bulletin sur service-public.fr), texte commun à tous les modèles. */
export const MENTION_SERVICE_PUBLIC = 'Pour davantage d\'informations, voir la rubrique dédiée au bulletin de paie sur www.service-public.fr.'

/**
 * Libellés imposés par l'arrêté du 25/02/2016 modifié (31/01/2023) pour les
 * lignes de CSG/CRDS. Le moteur garde ses noms internes (la DSN s'y appuie) ;
 * seuls les modèles imprimés les traduisent.
 */
export function libelleOfficiel(nom) {
  if (nom === 'CSG non imposable') return 'CSG déductible de l\'impôt sur le revenu'
  if (nom === 'CSG/CRDS imposable') return 'CSG/CRDS non déductible de l\'impôt sur le revenu'
  return nom
}

/**
 * Mention de la convention collective (R.3243-1 3°), commune aux modèles :
 * « IDCC 1486 - <intitulé> », ou, sans convention, la référence au Code du
 * travail pour les congés payés et le préavis. Jamais « IDCC 0000 », « DROIT
 * COMMUN - 0000 » ni « GENERAL » (code interne) comme avant le 17/11/2026.
 */
export function conventionMention(emp) {
  const conv = String(emp?.convention || '')
  const nom = String(emp?.conventionName || emp?.customConventionName || '').trim()
  const idccConv = (/^IDCC(\d{1,4})$/i.exec(conv) || [])[1] || ''
  const idcc = String(emp?.conventionIdcc || emp?.customConventionIdcc || idccConv).replace(/\D/g, '')
  const sansConvention = conv === 'GENERAL' || (!nom && !idcc) || /^0+$/.test(idcc)
  if (sansConvention) return 'Aucune - Code du travail (congés : L.3141-3 ; préavis : L.1234-1)'
  // « Convention collective nationale des … » est redondant derrière la
  // rubrique « Convention » / « CCN » : on le retire pour que le nom de la
  // branche (et son sigle entre parenthèses) tienne sans être coupé.
  const court = nom.replace(/^convention\s+collective\s+(nationale\s+)?(interrégionale\s+|régionale\s+|départementale\s+)?(de\s+la\s+|de\s+l'|du\s+|des\s+|de\s+|d')?/i, '').trim() || nom
  const intitule = court.charAt(0).toUpperCase() + court.slice(1)
  if (nom) return `${idcc ? `IDCC ${idcc} - ` : ''}${intitule}`
  return `IDCC ${idcc}`
}

/**
 * Taux salarial IMPRIMÉ d'une ligne : le taux nominal, sauf si le montant de la
 * ligne a déjà été réduit par une exonération (apprenti, art. L.6243-2) — on
 * imprime alors le taux effectif, pour que base × taux = montant reste vrai sur
 * le bulletin (présentation « taux effectifs » admise par le BOSS, bulletin de
 * paie, question 20). Avant le 17/11/2026 ces lignes imprimaient le taux plein
 * à côté du montant réduit.
 */
export function tauxSalAffiche(c) {
  const base = c?.base || 0, t = c?.tauxSal || 0, part = c?.partSal || 0
  if (base > 0 && t > 0 && Math.abs(base * t / 100 - part) > 0.02) return Math.round(part / base * 100000) / 1000
  return t
}

/**
 * Exonérations et allègements à imprimer sur UNE ligne, part salariale et part
 * patronale séparées, calculés comme l'écart entre la somme des lignes
 * imprimées et les totaux : la colonne se recalcule donc toujours au centime.
 * (Avant le 17/11/2026 les modèles traditionnel et cabinet imprimaient tout le
 * montant en part patronale : ni la colonne salariale ni la patronale ne
 * retombaient sur leur total.)
 */
export function exonerationsReparties(data) {
  const lignes = fusionCsgPsc(data?.cotisations || [])
  const r2 = (x) => Math.round(x * 100) / 100
  const sal = r2(lignes.reduce((a, c) => a + (c.partSal || 0), 0) - (data?.totalCotisSal || 0))
  const pat = r2(lignes.reduce((a, c) => a + (c.partPat || 0), 0) - (data?.totalCotisPat || 0))
  return { sal: Math.abs(sal) < 0.005 ? 0 : sal, pat: Math.abs(pat) < 0.005 ? 0 : pat }
}

/**
 * Montant de l'allègement de cotisations EMPLOYEUR : réduction générale et
 * déduction forfaitaire patronale sur heures sup. — sans la réduction
 * SALARIALE des heures sup. ni l'exonération salariale des apprentis, qui
 * étaient comptées dedans avant le 17/11/2026.
 */
export function allegementEmployeur(data) {
  return Math.max(0, Math.round(((data?.totalAllegements || 0) - (data?.exoCotisSalHS || 0) - (data?.exoCotisSalApprenti || 0)) * 100) / 100)
}

/**
 * Congés payés pris dans le mois (art. R.3243-1 12° : le bulletin mentionne les
 * dates de congé et le montant de l'indemnité). Absence = retenue au maintien ;
 * indemnité = maintien, ou dixième s'il est plus favorable (l'écart est dans le
 * brut du moteur) — la somme des lignes de gains retombe sur le brut. `absence` /
 * `absenceCourt` = libellé long / pour les colonnes étroites. null si rien à
 * imprimer (bulletins enregistrés avant le 11/10/2026 compris).
 */
export function lignesCongesPayes(data) {
  const cp = data && data.congesPayes
  const jours = parseFloat(cp && cp.jours) || 0
  const montant = Math.round((parseFloat(cp && cp.montant) || 0) * 100) / 100
  if (!cp || jours <= 0 || montant <= 0) return null
  // Retenue d'absence = maintien ; l'indemnité peut la dépasser (règle du
  // dixième, complément intégré au brut). Bulletins d'avant : retenue = montant.
  const retenue = Math.round((parseFloat(cp.retenue) || montant) * 100) / 100
  const d = formatDateFR(cp.debut)
  const f = formatDateFR(cp.fin)
  let periode = ''
  if (d && f) periode = d === f ? ` le ${d}` : ` du ${d.slice(6) === f.slice(6) ? d.slice(0, 5) : d} au ${f}`
  else if (d) periode = ` à partir du ${d}`
  else if (f) periode = ` jusqu'au ${f}`
  return {
    jours, montant, retenue,
    absence: `Absence congés payés${periode}`,
    absenceCourt: `Absence CP${periode}`,
    indemnite: montant > retenue ? 'Indemnité de congés payés (1/10e)' : 'Indemnité de congés payés',
  }
}

/**
 * La CSG/CRDS sur les parts patronales de prévoyance / santé (lignes `surPSC`
 * du moteur, montant calculé PAR DIFFÉRENCE avec la ligne principale) est
 * imprimée DANS la ligne CSG correspondante, dans TOUS les modèles : assiette =
 * 98,25 % du brut + parts patronales, base × taux = montant au centime. Imprimée
 * seule, une ligne calculée par différence pouvait afficher 17,84 × 2,9 % = 0,51
 * (relevé le 11/10/2026).
 */
export function fusionCsgPsc(cotisations) {
  const r2 = (x) => Math.round(x * 100) / 100
  const out = []
  ;(cotisations || []).forEach((c) => {
    if (!c.surPSC) { out.push({ ...c }); return }
    const cible = out.find((o) => o.isCSG && !o.surPSC && !!o.isImposable === !!c.isImposable)
    if (!cible) { out.push({ ...c }); return }
    cible.base = r2((parseFloat(cible.base) || 0) + (parseFloat(c.base) || 0))
    cible.partSal = r2((parseFloat(cible.partSal) || 0) + (parseFloat(c.partSal) || 0))
  })
  return out
}

/**
 * Constructeur du bulletin PDF. Reçoit le constructeur jsPDF (`JsPDF`) pour rester
 * isomorphe. `options.watermark = true` appose un filigrane SPÉCIMEN (aperçu non payé).
 * @returns instance jsPDF (non sauvegardée)
 */
/**
 * Construit le bulletin PDF (tous modèles) puis renseigne ses métadonnées :
 * titre, auteur = l'employeur, logiciel créateur = Salareo, date de création =
 * date d'émission du bulletin. Le champ « Producer » reste celui de la
 * bibliothèque (jsPDF) : on ne maquille jamais la provenance technique.
 *
 * Pourquoi : jusqu'au 17/11/2026 le PDF ne portait aucune métadonnée et sa date
 * de création était celle du téléchargement (un bulletin de janvier re-téléchargé
 * en novembre était « créé » en novembre, contrôle classique des outils
 * anti-fraude et de DossierFacile, qui affichent ces champs à leurs agents).
 * Pas de nom ni de numéro de sécurité sociale dans les métadonnées.
 *
 * @param {object} [options]
 * @param {string} [options.dateEmission]  ISO — date d'émission du bulletin
 *        (instantané figé), jamais antidatée. Absente : date du jour.
 */
export function buildPdfDoc(JsPDF, data, employerInfo, employeeInfo, month, year, template = 'classic', options = {}) {
  const Pdf = options.verrouiller === false ? JsPDF : jsPDFVerrouille(JsPDF)
  // Versement à compter du 01/01/2027 : modèle de l'article 1, quel que soit le modèle choisi.
  const doc = buildPdfDocModele(Pdf, data, employerInfo, employeeInfo, month, year, modeleApplicable(template, data, month, year), options)
  const periode = `${MOIS_FR[month] || ''} ${year}`.trim()
  const ref = String(options.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 32)
  doc.setProperties({
    title: `Bulletin de paie ${periode}`,
    subject: ref ? `Bulletin de paie - réf. ${ref}` : 'Bulletin de paie',
    author: String(employerInfo?.nom || '').trim(),
    keywords: ['bulletin de paie', periode, ref && `réf. ${ref}`, 'émis par Salareo'].filter(Boolean).join(', '),
    creator: 'Salareo - logiciel de paie',
  })
  const emission = options?.dateEmission ? new Date(options.dateEmission) : null
  if (emission && !isNaN(emission.getTime())) {
    try { doc.setCreationDate(emission) } catch { /* hors plage jsPDF : date du jour */ }
  }
  return doc
}

/**
 * Bulletin verrouillé comme un relevé bancaire : ouverture libre, impression et
 * copie permises, modification et annotations interdites. Mot de passe
 * propriétaire aléatoire, connu de personne.
 * shortcut: restrictions PDF standard (RC4), retirables par un outil spécialisé ;
 * passer à une signature électronique côté serveur pour une vraie preuve d'intégrité.
 */
function jsPDFVerrouille(JsPDF) {
  const octets = new Uint8Array(16)
  globalThis.crypto.getRandomValues(octets)
  const ownerPassword = Array.from(octets, (x) => x.toString(16).padStart(2, '0')).join('')
  return function Verrouille(orientation, unit, format) {
    const o = orientation && typeof orientation === 'object' ? orientation : { orientation, unit, format }
    return new JsPDF({ ...o, encryption: { userPassword: '', ownerPassword, userPermissions: ['print', 'copy'] } })
  }
}

function buildPdfDocModele(JsPDF, data, employerInfo, employeeInfo, month, year, template = 'classic', options = {}) {
  // Le modèle « traditionnel » ne partage AUCUNE géométrie avec les trois autres
  // (monospace, 5 colonnes propres, rubriques en capitales, pagination à en-tête
  // répété). Il est donc rendu par une fonction dédiée plutôt qu'en ajoutant une
  // palette ici : aucune régression possible sur classic/modern/minimalist, et le
  // moteur « une page garantie » ci-dessous ne s'applique pas à lui.
  if (template === 'traditionnel') {
    return buildTraditionnelDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }
  // Même logique pour « cabinet » : géométrie propre (grille + calendrier
  // journalier), rendu par sa propre fonction.
  if (template === 'cabinet') {
    return buildCabinetDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }
  // « encadré » : cadres arrondis + cumuls/congés, décrit par layoutEncadre
  // (même description pour le PDF et l'aperçu écran).
  if (template === 'encadre') {
    return buildEncadreDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }
  // « colonnes » : en-tête et tableau à colonnes bleus, une page, décrit par
  // layoutColonnes (même description pour le PDF et l'aperçu écran).
  if (template === 'colonnes') {
    return buildColonnesDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }
  if (template === 'officiel2027') {
    return buildColonnesDoc(JsPDF, data, employerInfo, employeeInfo, month, year, { ...options, modele2027: true })
  }
  // « cabinet clarifié » : grille + calendrier, rubriques regroupées, RIB —
  // décrit par layoutCabinetClarifie (même description pour l'aperçu écran).
  if (template === 'cabinetClarifie') {
    return buildCabinetClarifieDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }
  const cotisAffichees = fusionCsgPsc(data.cotisations)

  const doc = new JsPDF('p', 'mm', 'a4')
  const pageW = 210
  const margin = 10
  const contentW = pageW - margin * 2
  let y = margin

  const periodLabel = `${MOIS_FR[month]} ${year}`
  const lastDay = new Date(year, month + 1, 0).getDate()
  // Période réelle : bornée aux dates d'entrée/sortie si mois incomplet (proratisation B6).
  const periodStart = data.proration?.periodeDebut || `01/${String(month + 1).padStart(2, '0')}/${year}`
  const periodEnd = data.proration?.periodeFin || `${lastDay}/${String(month + 1).padStart(2, '0')}/${year}`
  const datePaie = datePaiementDe(data, month, year, periodEnd)

  // Colors (Dynamic based on selected template)
  let PRIMARY = [29, 29, 31]      // Default: #1d1d1f (Apple Ink)
  let SECONDARY = [245, 245, 247] // Default: #f5f5f7 (Apple Parchment)
  const WHITE = [255, 255, 255]
  const BLACK = [29, 29, 31]        // #1d1d1f
  const GRAY = [134, 134, 139]      // #86868b (Apple Muted Gray)
  let LIGHT_GRAY = [250, 250, 252] // #fafafc (Apple Pearl)
  let BORDER_GRAY = [210, 210, 215] // #d2d2d7 (Apple Hairline Border)
  const DANGER_RED = [208, 44, 47]  // #d02c2f (Apple Red)
  const SUCCESS_GREEN = [36, 138, 61] // #248a3d (Apple Green)
  let CATEGORY_BG = [245, 245, 247]
  let CATEGORY_TEXT = [29, 29, 31]

  if (template === 'classic') {
    PRIMARY = [31, 56, 100]        // Corporate Blue (#1f3864)
    SECONDARY = [217, 225, 242]    // Light Blue Accent (#d9e1f2)
    LIGHT_GRAY = [242, 247, 255]
    BORDER_GRAY = [200, 210, 225]
    CATEGORY_BG = [232, 240, 254]  // #e8f0fe
    CATEGORY_TEXT = [31, 56, 100]
  } else if (template === 'modern') {
    PRIMARY = [0, 102, 204]        // Apple Action Blue (#0066cc)
    SECONDARY = [224, 242, 254]    // Sky Light (#e0f2fe)
    LIGHT_GRAY = [245, 247, 250]
    BORDER_GRAY = [210, 220, 235]
    CATEGORY_BG = [224, 242, 254]  // #e0f2fe
    CATEGORY_TEXT = [0, 102, 204]
  } else if (template === 'minimalist') {
    PRIMARY = [26, 26, 26]          // Minimalist Black (#1a1a1a)
    SECONDARY = [244, 244, 245]    // Zinc Light (#f4f4f5)
    LIGHT_GRAY = [250, 250, 250]
    BORDER_GRAY = [228, 228, 230]
    CATEGORY_BG = [244, 244, 245]  // #f4f4f5
    CATEGORY_TEXT = [26, 26, 26]
  }

  // ─── 0. WATERMARK BACKGROUND FOR MODERN TEMPLATE ───
  if (template === 'modern') {
    // We draw a large, soft, single pastel circle in the middle-bottom background
    doc.setFillColor(243, 245, 254) // Extremely light violet-blue
    doc.circle(105, 160, 52, 'F')
  }

  // ─── Helper functions ───
  function setColor(rgb) {
    doc.setTextColor(rgb[0], rgb[1], rgb[2])
  }

  function fillRect(x, yy, w, h, color) {
    doc.setFillColor(color[0], color[1], color[2])
    doc.rect(x, yy, w, h, 'F')
  }

  function drawRect(x, yy, w, h) {
    doc.setDrawColor(BORDER_GRAY[0], BORDER_GRAY[1], BORDER_GRAY[2])
    doc.setLineWidth(0.15)
    doc.rect(x, yy, w, h, 'S')
  }

  function drawLine(x1, y1, x2, y2, width = 0.15) {
    doc.setDrawColor(BORDER_GRAY[0], BORDER_GRAY[1], BORDER_GRAY[2])
    doc.setLineWidth(width)
    doc.line(x1, y1, x2, y2)
  }

  function textRight(text, x, yy) {
    const safe = text == null || Number.isNaN(text) ? '' : String(text)
    const w = doc.getTextWidth(safe)
    doc.text(safe, x - w, yy)
  }

  function safeText(text, x, yy, options) {
    const safe = text == null || Number.isNaN(text) ? '' : String(text)
    if (options) doc.text(safe, x, yy, options)
    else doc.text(safe, x, yy)
  }

  // Wrap doc.text globally so that ANY direct call elsewhere in this builder
  // (existing or future) can never crash on undefined/null/NaN values again.
  // Sanitizes text (null/undefined/NaN → ''), arrays (map each element),
  // AND coordinates x/y (NaN/undefined → 0) which also cause the jsPDF throw.
  const _rawText = doc.text.bind(doc)
  doc.text = (text, x, yy, options) => {
    let safe
    if (Array.isArray(text)) {
      safe = text.map(t => (t == null || (typeof t === 'number' && Number.isNaN(t))) ? '' : String(t))
    } else {
      safe = (text == null || (typeof text === 'number' && Number.isNaN(text))) ? '' : String(text)
    }
    const sx = (typeof x !== 'number' || Number.isNaN(x)) ? 0 : x
    const sy = (typeof yy !== 'number' || Number.isNaN(yy)) ? 0 : yy
    return options ? _rawText(safe, sx, sy, options) : _rawText(safe, sx, sy)
  }

  // Format SIRET : 14 chiffres → XXX XXX XXX XXXXX
  const formatSIRET = (siret) => {
    const digits = String(siret || '').replace(/\s/g, '')
    if (digits.length === 14) {
      return `${digits.slice(0,3)} ${digits.slice(3,6)} ${digits.slice(6,9)} ${digits.slice(9)}`
    }
    return siret || ''
  }

  // Tronque une chaîne à la largeur dispo (mesure jsPDF avec la police courante).
  const fitText = (str, maxW) => {
    if (!str) return ''
    if (doc.getTextWidth(str) <= maxW) return str
    let s = str
    while (s.length > 1 && doc.getTextWidth(s.trimEnd() + '…') > maxW) s = s.slice(0, -1)
    return s.trimEnd() + '…'
  }

  // Mention obligatoire (R.3243-1) : intitulé + IDCC de la convention. Piloté par
  // le libellé officiel figé dans la fiche employeur ; repli sur les anciens codes.
  const formatConvText = (conv, maxW) => {
    if (employerInfo.conventionName) {
      const idcc = employerInfo.conventionIdcc || ''
      // IDCC en tête (jamais tronqué : c'est la référence légale précise), puis le
      // libellé officiel tronqué à la largeur dispo.
      const prefix = idcc ? `IDCC ${idcc} — ` : ''
      return prefix + fitText(employerInfo.conventionName, Math.max(10, maxW - doc.getTextWidth(prefix)))
    }
    if (conv === 'IDCC1486' || conv === 'Syntec') return 'SYNTEC - 1486'
    if (conv === 'IDCC1979' || conv === 'HCR') return 'HCR - 1979'
    if (conv === 'IDCC2148') return 'TELECOMS - 2148'
    if (conv === 'IDCC3248') return 'METALLURGIE - 3248'
    if (conv === 'CUSTOM') return `IDCC ${employerInfo.customConventionIdcc || ''}`
    // Sans convention : R.3243-1 3° impose la référence au Code du travail
    // (congés payés, préavis). « DROIT COMMUN - 0000 » n'est pas un IDCC réel.
    return 'Aucune - Code du travail (congés : L.3141-3 ; préavis : L.1234-1)'
  }

  // Seniority calculation
  const getAncienneté = (dateEntree, dateFinStr) => {
    if (!dateEntree) return '1 mois'
    const entry = new Date(dateEntree)
    const parts = dateFinStr.split('/')
    const end = new Date(parts[2], parts[1] - 1, parts[0])
    if (isNaN(entry.getTime()) || isNaN(end.getTime())) return '1 mois'
    
    let months = (end.getFullYear() - entry.getFullYear()) * 12 + (end.getMonth() - entry.getMonth())
    if (end.getDate() < entry.getDate()) months--
    
    if (months <= 0) return '0 mois'
    const yrs = Math.floor(months / 12)
    const mths = months % 12
    
    if (yrs > 0) {
      return `${yrs} an${yrs > 1 ? 's' : ''} ${mths > 0 ? `${mths} mois` : ''}`
    }
    return `${mths} mois`
  }

  const seniority = getAncienneté(employeeInfo.dateEntree, periodEnd)

  // ═══ 1. TITLE ═══
  doc.setFontSize(9)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('BULLETIN DE PAIE', pageW / 2, y + 4, { align: 'center' })
  const bpWidth = doc.getTextWidth('BULLETIN DE PAIE') // mesuré à 9pt bold avant changement de fonte
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  setColor(GRAY)
  doc.text(' - EN EUROS', pageW / 2 + bpWidth / 2 + 1, y + 4)
  y += 9

  // ═══ 2. 3-COLUMN IDENTITIES HEADER ═══
  const colW1 = 60
  const colW2 = 62
  const colW3 = 68

  // Col 1: Employer
  doc.setFontSize(8)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text(fitText(employerInfo.nom || '', colW1), margin, y + 3)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  setColor(BLACK)
  doc.text(fitText(employerInfo.adresse || '', colW1), margin, y + 7)
  doc.text(fitText(`${employerInfo.codePostal || ''} ${employerInfo.ville || ''}`.trim(), colW1), margin, y + 10)
  setColor(GRAY)
  doc.text(`SIRET : ${formatSIRET(employerInfo.siret)}`, margin, y + 14)
  doc.text(`Code APE : ${employerInfo.codeAPE || ''}`, margin, y + 17)
  // Intitulé de la convention (R.3243-1 3°) sur 3 lignes au plus : il était
  // tronqué à « Convention collective na… », sans le nom de la branche.
  const convTexte = conventionMention(employerInfo)
  const convLignes = doc.splitTextToSize(`Convention : ${convTexte}`, colW1 - 1)
  convLignes.slice(0, 3).forEach((l, i) => {
    doc.text(i === 2 && convLignes.length > 3 ? fitText(`${l} ${convLignes[3]}`, colW1 - 1) : l, margin, y + 20 + i * 3)
  })

  // Col 2: Employee
  doc.setFontSize(8)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text(fitText(`${employeeInfo.prenom} ${employeeInfo.nom}`, colW2 - 5), margin + colW1 + 5, y + 3)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  setColor(BLACK)
  // Adresse salariale (obligatoire sur le bulletin)
  doc.text(fitText(employeeInfo.adresse || '-', colW2 - 5), margin + colW1 + 5, y + 7)
  doc.text(fitText(`${employeeInfo.codePostal || ''} ${employeeInfo.ville || ''}`.trim() || '-', colW2 - 5), margin + colW1 + 5, y + 10)
  doc.text(`N° Sécu : ${employeeInfo.numSecu || '-'}`, margin + colW1 + 5, y + 13.5)
  doc.text(`Matricule : ${employeeInfo.matricule || '-'}`, margin + colW1 + 5, y + 16.5)
  setColor(GRAY)
  doc.text(`Début de période :`, margin + colW1 + 5, y + 20)
  doc.text(`Fin de période :`, margin + colW1 + 5, y + 23)
  doc.text(`Début de contrat :`, margin + colW1 + 5, y + 26)
  doc.text(`Date d'ancienneté :`, margin + colW1 + 5, y + 29)

  setColor(BLACK)
  textRight(periodStart, margin + colW1 + colW2 - 2, y + 20)
  textRight(periodEnd, margin + colW1 + colW2 - 2, y + 23)
  textRight(formatDateFR(employeeInfo.dateEntree) || '-', margin + colW1 + colW2 - 2, y + 26)
  textRight(seniority, margin + colW1 + colW2 - 2, y + 29)

  // Col 3: Salary detail box (32mm pour aligner avec les lignes col 2 + adresse)
  fillRect(margin + colW1 + colW2 + 2, y, colW3 - 2, 32, LIGHT_GRAY)
  drawRect(margin + colW1 + colW2 + 2, y, colW3 - 2, 32)
  doc.setFontSize(7)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Détail du salarié', margin + colW1 + colW2 + 5, y + 5)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6)
  setColor(BLACK)
  // Classification conventionnelle (mention obligatoire R.3243-1 4°) : position
  // du salarié = niveau / échelon / coefficient. Repli sur le statut si non saisi.
  const classifParts = [
    employeeInfo.niveau && `Niv. ${employeeInfo.niveau}`,
    employeeInfo.echelon && `Éch. ${employeeInfo.echelon}`,
    employeeInfo.coefficient && `Coef. ${employeeInfo.coefficient}`,
  ].filter(Boolean)
  const classifText = classifParts.length ? classifParts.join(' · ') : (employeeInfo.statut || '—')
  const col3X = margin + colW1 + colW2 + 5
  doc.text(fitText(`Emploi : ${employeeInfo.emploi || ''}`, contentW - (col3X - margin)), col3X, y + 9)
  doc.text(`Statut : ${employeeInfo.statut || '—'}`, col3X, y + 13)
  doc.text(`Classification : ${classifText}`, col3X, y + 17)
  doc.text(`Salaire de base : ${formatMontant(data.salaireBase)} €`, col3X, y + 21)
  doc.text(`Durée mensuelle : ${data.horaireMensuel} h`, col3X, y + 25)
  doc.text(`Taux horaire : ${formatMontant(data.tauxHoraire)} €/h`, col3X, y + 29)

  // Séparateur header — couleur PRIMARY, plus épais
  doc.setDrawColor(PRIMARY[0], PRIMARY[1], PRIMARY[2])
  doc.setLineWidth(0.4)
  doc.line(margin, y + 34, margin + contentW, y + 34)
  y += 36

  // ═══ AJUSTEMENT UNE-PAGE (échelle continue : gaps d'abord, puis lignes) ═══
  // Ancres basses FIXES : la grille du bas (hauteur constante GRID_H) doit finir
  // au-dessus du footer épinglé (FOOTER_Y). On mesure la hauteur naturelle du
  // CORPS du tableau (hors bandeau d'en-tête, jamais compressé), puis :
  //  1) si ça tient avec les gaps de confort  → aucun changement (fiche simple aérée)
  //  2) sinon on resserre GAP1 puis GAP2 (confort→min) AVANT toute compression
  //  3) sinon seulement on compresse les lignes par `scale`.
  // Aucun clamp bas sur `scale` : scale = min(1, budget/corps) ⇒ 1 page garantie
  // pour TOUT contenu (le plancher de lisibilité est assuré par le cap de saisie).
  const yAfterIdentity = y            // ≈ 55, lu en direct (robuste au changement d'en-tête)
  const FOOTER_Y   = 258
  const SAFETY     = 3
  const GRID_H     = 46.1             // colonne droite (la plus haute) : congés + cumuls
  const HEADER_H   = 5                // bandeau d'en-tête du tableau (NON compressé)
  const GAP1_COMFORT = 20, GAP1_MIN = 6
  const GAP2_COMFORT = 12, GAP2_MIN = 5
  const GRID_Y_MAX = FOOTER_Y - SAFETY - GRID_H     // 208.9
  const budget     = GRID_Y_MAX - yAfterIdentity    // ≈ 153.9 : GAP1 + HEADER_H + scale·corps + GAP2

  let ROW_H = 4, CAT_H = 3.8, NET_H = 4.8, DISC_H = 3.2
  let GAP1 = GAP1_COMFORT, GAP2 = GAP2_COMFORT
  let tableBodyDrawn = 0
  {
    let hsCount = 0
    if (data.heuresSuppLignes && data.heuresSuppLignes.length > 0)
      hsCount = data.heuresSuppLignes.filter(l => (l.heures || 0) > 0).length
    else if (data.heuresSupp > 0) hsCount = 1
    let primeCount = 0
    if (data.primes && data.primes.length > 0)
      primeCount = data.primes.filter(p => (p.montant || 0) > 0).length
    else if (data.primeExceptionnelle > 0) primeCount = 1
    if (lignesCongesPayes(data)) primeCount += 2
    let catCount = 0, prevCat = null
    cotisAffichees.forEach(c => { if (c.category !== prevCat) { catCount++; prevCat = c.category } })
    const hasAlleg = data.exoCotisSalHS > 0 || data.reductionGenerale > 0
    const allegDataRows = (data.reductionGenerale > 0 ? 1 : 0) + (data.exoCotisSalHS > 0 ? 2 : 0)
    const rowUnits = 1 + hsCount + primeCount + 1 + cotisAffichees.length + allegDataRows + 1 + 1
    const catUnits = catCount + (hasAlleg ? 1 : 0)
    const body = rowUnits * ROW_H + catUnits * CAT_H + NET_H + DISC_H   // dense ≈ 166

    const comfortNeed = GAP1_COMFORT + HEADER_H + body + GAP2_COMFORT
    if (comfortNeed > budget) {
      // Paliers 1+2 : resserrer les gaps (confort → min), proportionnellement.
      const gapSlack   = (GAP1_COMFORT - GAP1_MIN) + (GAP2_COMFORT - GAP2_MIN)   // 21
      const gapReclaim = Math.min(comfortNeed - budget, gapSlack)
      GAP1 = GAP1_COMFORT - (GAP1_COMFORT - GAP1_MIN) * (gapReclaim / gapSlack)
      GAP2 = GAP2_COMFORT - (GAP2_COMFORT - GAP2_MIN) * (gapReclaim / gapSlack)
      // Palier 3 : s'il reste du déficit, compresser les lignes pour tenir EXACTEMENT.
      const bodyBudget = budget - GAP1 - HEADER_H - GAP2
      if (body > bodyBudget) {
        const scale = bodyBudget / body        // < 1 ; aucun clamp bas ⇒ pas de falaise
        ROW_H *= scale; CAT_H *= scale; NET_H *= scale; DISC_H *= scale
      }
    }
    tableBodyDrawn = rowUnits * ROW_H + catUnits * CAT_H + NET_H + DISC_H
  }
  const GAP2_H = GAP2                   // consommé au GAP 2

  // Pas du calendrier borné pour ne jamais dépasser le bas du tableau (fiche courte)
  const calDayPitch = Math.min(2.2, Math.max(1.7, (HEADER_H + tableBodyDrawn - 4) / lastDay))

  // ═══ GAP 1 (élastique) ═══
  y += GAP1

  // ═══ 3. MAIN TABLE & SIDE CALENDAR ═══
  const tableX = margin
  const tableW = 155
  const calX = margin + 160
  const calW = 30

  // ─── Draw Side Calendar ───
  let calY = y
  const calYStart = y
  fillRect(calX, calY, calW, 4, PRIMARY)
  drawRect(calX, calY, calW, 4)
  doc.setFontSize(5.5)
  doc.setFont('helvetica', 'bold')
  setColor(WHITE)
  doc.text('CALENDRIER', calX + calW / 2, calY + 2.8, { align: 'center' })
  calY += 4

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(4.8)
  const dayLetters = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month, d)
    const dayOfWeek = date.getDay()
    const dayLetter = dayLetters[dayOfWeek]
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6

    if (isWeekend) {
      fillRect(calX, calY, calW, calDayPitch, [230, 235, 245])
    }
    doc.setDrawColor(240, 245, 250)
    doc.rect(calX, calY, calW, calDayPitch, 'S')

    setColor(isWeekend ? GRAY : BLACK)
    doc.text(`${dayLetter} ${String(d).padStart(2, '0')}`, calX + 2, calY + calDayPitch * 0.72)
    if (isWeekend) {
      doc.text('WE', calX + calW - 6, calY + calDayPitch * 0.72)
    }
    calY += calDayPitch
  }
  const calYAfterDays = calY

  // ─── Draw Main Table Header ───
  const colWidths = [63, 22, 22, 24, 24] // total = 155
  fillRect(tableX, y, tableW, 5, PRIMARY)
  doc.setFontSize(6.5)
  doc.setFont('helvetica', 'bold')
  setColor(WHITE)
  const headers = ['DÉSIGNATION', 'BASE', 'TAUX OU %', 'PART SALARIÉ', 'PART EMPLOYEUR']
  let cx = tableX
  headers.forEach((h, i) => {
    if (i === 0) {
      doc.text(h, cx + 2, y + 3.5)
    } else {
      textRight(h, cx + colWidths[i] - 1, y + 3.5)
    }
    cx += colWidths[i]
  })
  y += 5

  function drawPdfRow(cells, options = {}) {
    const { bold = false, bgColor = null, textColor = BLACK, indent = false, height = ROW_H } = options

    if (bgColor) {
      fillRect(tableX, y, tableW, height, bgColor)
    }

    // Police proportionnelle à la hauteur de ligne (max 6.2pt) pour rester
    // lisible sans déborder quand les lignes sont compressées.
    doc.setFontSize(Math.min(6.2, height * 1.55))
    doc.setFont('helvetica', bold ? 'bold' : 'normal')
    setColor(textColor)

    const baseline = y + height * 0.72
    let rx = tableX
    cells.forEach((cell, i) => {
      const safe = cell == null ? '' : String(cell)
      if (i === 0) {
        // Libellé jamais tronqué avant : un intitulé long (ex. "Contribution
        // formation professionnelle (CFP, <11 salariés)") débordait de la colonne
        // DÉSIGNATION (63mm) et se superposait au montant de la colonne BASE juste
        // à droite. fitText() est déjà utilisé plus haut dans ce fichier pour le
        // même problème (convention collective) — même traitement ici.
        const pad = indent ? 5 : 2
        doc.text(fitText(safe, colWidths[0] - pad - 1), rx + pad, baseline)
      } else {
        textRight(safe, rx + colWidths[i] - 1, baseline)
      }
      rx += colWidths[i]
    })

    drawLine(tableX, y + height, tableX + tableW, y + height)
    y += height
  }

  // Base rows
  drawPdfRow([
    'Salaire de base',
    formatMontant(data.horaireMensuel),
    formatTaux(data.tauxHoraire),
    formatMontant(data.salaireBase),
    '-'
  ], { bold: true })

  if (data.heuresSuppLignes && data.heuresSuppLignes.length > 0) {
    data.heuresSuppLignes.forEach(line => {
      if ((line.heures || 0) > 0) {
        drawPdfRow([
          line.label || `HS ${line.tauxMult}%`,
          formatMontant(line.heures),
          formatTaux(line.computedTauxHS),
          formatMontant(line.brut),
          '-'
        ])
      }
    })
  } else if (data.heuresSupp > 0) {
    drawPdfRow([
      'Heures supplémentaires',
      formatMontant(data.heuresSupp),
      formatTaux(data.tauxHS),
      formatMontant(data.hsBrut),
      '-'
    ])
  }

  if (data.primes && data.primes.length > 0) {
    data.primes.forEach(prime => {
      if ((prime.montant || 0) > 0) {
        drawPdfRow([
          prime.label || 'Prime',
          '-', '-',
          formatMontant(prime.montant),
          '-'
        ])
      }
    })
  } else if (data.primeExceptionnelle > 0) {
    drawPdfRow([
      'Prime exceptionnelle', '-', '-',
      formatMontant(data.primeExceptionnelle),
      '-'
    ])
  }

  const cpClassic = lignesCongesPayes(data)
  if (cpClassic) {
    drawPdfRow([cpClassic.absence, `${formatMontant(cpClassic.jours)} j`, '-', formatMontant(-cpClassic.retenue), '-'])
    drawPdfRow([cpClassic.indemnite, `${formatMontant(cpClassic.jours)} j`, '-', formatMontant(cpClassic.montant), '-'])
  }

  // TOTAL BRUT
  drawPdfRow([
    'Rémunération brute  (1)', '-', '-',
    formatMontant(data.totalBrut),
    '-'
  ], { bold: true, bgColor: LIGHT_GRAY, textColor: PRIMARY })

  // Cotisations
  let currentCat = null
  cotisAffichees.forEach((c) => {
    if (c.category !== currentCat) {
      currentCat = c.category
      // Draw category title row
      fillRect(tableX, y, tableW, CAT_H, CATEGORY_BG)
      doc.setFontSize(Math.min(6.2, CAT_H * 1.6))
      doc.setFont('helvetica', 'bold')
      setColor(CATEGORY_TEXT)
      doc.text(c.category ?? '', tableX + 2, y + CAT_H * 0.68)
      drawLine(tableX, y + CAT_H, tableX + tableW, y + CAT_H)
      y += CAT_H
    }
    drawPdfRow([
      libelleOfficiel(c.name),
      formatMontant(c.base),
      c.tauxSal > 0 ? formatTaux(tauxSalAffiche(c)) : '-',
      c.partSal > 0 ? formatMontant(c.partSal) : '-',
      c.partPat > 0 ? formatMontant(c.partPat) : '-'
    ], { indent: true })
  })

  // Allègements
  if (data.exoCotisSalHS > 0 || data.reductionGenerale > 0) {
    fillRect(tableX, y, tableW, CAT_H, CATEGORY_BG)
    doc.setFontSize(Math.min(6.2, CAT_H * 1.6))
    doc.setFont('helvetica', 'bold')
    setColor(CATEGORY_TEXT)
    doc.text('Exonérations et allègements de cotisations', tableX + 2, y + CAT_H * 0.68)
    drawLine(tableX, y + CAT_H, tableX + tableW, y + CAT_H)
    y += CAT_H

    if (data.reductionGenerale > 0) {
      drawPdfRow([
        'Réduction générale (allègement employeur)',
        formatMontant(data.totalBrut),
        '-',
        '-',
        `-${formatMontant(data.reductionGenerale)}`
      ], { indent: true, textColor: SUCCESS_GREEN })
    }

    if (data.exoCotisSalHS > 0) {
      drawPdfRow([
        'Exonération cotis. sal. sur HS',
        formatMontant(data.hsBrut),
        formatTaux(data.tauxExoSal),
        `-${formatMontant(data.exoCotisSalHS)}`,
        '-'
      ], { indent: true, textColor: SUCCESS_GREEN })

      drawPdfRow([
        'Allègement patronal HS',
        formatMontant(data.heuresSupp),
        '-',
        '-',
        `-${formatMontant(data.allegementPatHS)}`
      ], { indent: true, textColor: SUCCESS_GREEN })
    }
  }

  // TOTAL RETENUES
  drawPdfRow([
    'Total des cotisations et contributions  (4)', '-', '-',
    formatMontant(data.totalCotisSal),
    formatMontant(data.totalCotisPat)
  ], { bold: true, bgColor: LIGHT_GRAY, textColor: PRIMARY })

  // Montant net social
  drawPdfRow([
    'Montant net social', '', '',
    `${formatMontant(data.netSocial)} €`, ''
  ], { bold: true, bgColor: SECONDARY, textColor: PRIMARY })

  // Net avant IR
  drawPdfRow([
    'NET À PAYER AVANT IMPÔT SUR LE REVENU', '', '',
    `${formatMontant(data.netAvantIR)} €`, ''
  ], { bold: true, bgColor: SECONDARY, textColor: PRIMARY, height: NET_H })

  // Disclaimer text
  doc.setFontSize(Math.min(5.5, DISC_H * 1.7))
  doc.setFont('helvetica', 'italic')
  setColor(GRAY)
  // Ancienne ligne « Dont évolution de la rémunération… : 0,00 € » : montant figé
  // à 0 quel que soit le salaire (faux), et ligne facultative depuis l'arrêté de
  // 2023 (BOSS, bulletin de paie, question 5). Remplacée par la mention
  // obligatoire de la rubrique service-public (R.3243-1 15°).
  doc.text(MENTION_SERVICE_PUBLIC, tableX + 2, y + DISC_H * 0.7)
  drawLine(tableX, y + DISC_H, tableX + tableW, y + DISC_H)
  y += DISC_H

  // ─── Étirer le calendrier jusqu'en bas du tableau ───
  if (calYAfterDays < y) {
    let extY = calYAfterDays
    while (extY + 2.2 <= y) {
      doc.setFillColor(248, 250, 252)
      doc.setDrawColor(235, 240, 248)
      doc.setLineWidth(0.08)
      doc.rect(calX, extY, calW, 2.2, 'FD')
      extY += 2.2
    }
    if (extY < y) {
      doc.setFillColor(248, 250, 252)
      doc.setDrawColor(235, 240, 248)
      doc.rect(calX, extY, calW, y - extY, 'FD')
    }
  }
  // Bordure basse du calendrier
  doc.setDrawColor(BORDER_GRAY[0], BORDER_GRAY[1], BORDER_GRAY[2])
  doc.setLineWidth(0.2)
  doc.line(calX, y, calX + calW, y)

  // ═══ GAP 2: Between main table and bottom cumulative grid ═══
  y += GAP2_H

  // ═══ 4. BOTTOM GRID SPLIT INTO 2 COLUMNS ═══
  const gridW = 92
  const gridYStart = y

  // ─── LEFT COLUMN ───
  let leftY = gridYStart

  // Box A: Impôt sur le revenu
  fillRect(margin, leftY, gridW, 3.8, LIGHT_GRAY)
  drawRect(margin, leftY, gridW, 3.8)
  doc.setFontSize(6.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Impôt sur le revenu', margin + 2.5, leftY + 2.6)
  leftY += 3.8

  // Impot Headers
  const impotColW = gridW / 4
  fillRect(margin, leftY, gridW, 3.5, LIGHT_GRAY)
  drawRect(margin, leftY, gridW, 3.5)
  doc.setFontSize(5.5)
  doc.setFont('helvetica', 'bold')
  setColor(GRAY)
  doc.text('Rubrique', margin + 2, leftY + 2.4)
  textRight('Base', margin + impotColW * 2 - 1, leftY + 2.4)
  textRight('Taux', margin + impotColW * 3 - 1, leftY + 2.4)
  textRight('Montant', margin + gridW - 2, leftY + 2.4)
  leftY += 3.5

  // Impot data
  drawRect(margin, leftY, gridW, 4.5)
  doc.setFontSize(6)
  doc.setFont('helvetica', 'normal')
  setColor(BLACK)
  doc.text('Prélevé à la source (5)', margin + 2, leftY + 3)
  textRight(`${formatMontant(data.baseIR)}`, margin + impotColW * 2 - 1, leftY + 3)
  textRight(`${formatTaux(data.tauxIR)} %`, margin + impotColW * 3 - 1, leftY + 3)
  doc.setFont('helvetica', 'bold')
  setColor(DANGER_RED)
  textRight(`-${formatMontant(data.irPreleve)}`, margin + gridW - 2, leftY + 3)
  leftY += 4.5
  // Mention obligatoire dès qu'il y a des heures sup./compl. exonérées d'impôt
  // (arrêté du 31/01/2023 : « Montant net des heures compl/suppl exonérées »).
  if ((data.montantNetHSExonere || 0) > 0) {
    drawRect(margin, leftY, gridW, 4.5)
    doc.setFont('helvetica', 'normal')
    setColor(BLACK)
    doc.text('Montant net des heures compl/suppl exonérées', margin + 2, leftY + 3)
    doc.setFont('helvetica', 'bold')
    textRight(formatMontant(data.montantNetHSExonere), margin + gridW - 2, leftY + 3)
    leftY += 4.5
  }
  leftY += 3.5

  // Box B: Autres Informations
  fillRect(margin, leftY, gridW, 3.8, LIGHT_GRAY)
  drawRect(margin, leftY, gridW, 3.8)
  doc.setFontSize(6.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Autres Informations', margin + 2.5, leftY + 2.6)
  leftY += 3.8

  // Info details list
  const infoItems = [
    { label: 'Total versé par l\'employeur :', val: `${formatMontant(data.totalVerseEmployeur)} €`, color: BLACK },
    { label: 'Allègement de cotisations employeur :', val: `${formatMontant(allegementEmployeur(data))} €`, color: SUCCESS_GREEN },
    { label: 'Net imposable :', val: `${formatMontant(data.baseIR)} €`, color: BLACK },
    { label: 'Temps travaillé ce mois :', val: `${formatMontant(data.horaireMensuel + data.heuresSupp)} h`, color: BLACK }
  ]

  drawRect(margin, leftY, gridW, 20)
  doc.setFontSize(6)
  infoItems.forEach((item, idx) => {
    doc.setFont('helvetica', 'normal')
    setColor(GRAY)
    doc.text(item.label, margin + 3, leftY + 4 + idx * 4.5)
    doc.setFont('helvetica', 'bold')
    setColor(item.color)
    textRight(item.val, margin + gridW - 3, leftY + 4 + idx * 4.5)
  })

  // ─── RIGHT COLUMN ───
  let rightY = gridYStart
  const rightX = margin + gridW + 6

  // Box C: Soldes de congés
  fillRect(rightX, rightY, gridW, 3.8, LIGHT_GRAY)
  drawRect(rightX, rightY, gridW, 3.8)
  doc.setFontSize(6.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Soldes de congés', rightX + 2.5, rightY + 2.6)
  rightY += 3.8

  // Congés Headers (4 columns)
  const cW0 = gridW * 0.34
  const cW1 = gridW * 0.22
  const cW2 = gridW * 0.22
  const cW3 = gridW * 0.22

  fillRect(rightX, rightY, gridW, 3.5, LIGHT_GRAY)
  drawRect(rightX, rightY, gridW, 3.5)
  doc.setFontSize(5.5)
  doc.setFont('helvetica', 'bold')
  setColor(GRAY)
  doc.text('Libellé', rightX + 2, rightY + 2.4)
  textRight('CP N-1', rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight('CP N', rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  // Colonne RTT laissée VIDE (en-tête compris) pour un salarié sans RTT —
  // c'est-à-dire tout salarié à 35 h sans accord : afficher « RTT 0,00 »
  // suggérait un droit qui n'existe pas. La géométrie de la grille est
  // inchangée (aucune régression de mise en page sur ces 3 modèles).
  const lv0 = data.leave
  const avecRtt = lv0
    ? ((lv0.rttAcquis || 0) > 0 || (lv0.cumulRttPris || 0) > 0)
    : (parseFloat(employeeInfo.rtt) || 0) > 0
  if (avecRtt) textRight('RTT', rightX + gridW - 2, rightY + 2.4)
  rightY += 3.5

  // Acquis row
  drawRect(rightX, rightY, gridW, 3.5)
  doc.setFontSize(5.8)
  doc.setFont('helvetica', 'normal')
  setColor(BLACK)
  doc.text('Acquis', rightX + 2, rightY + 2.4)
  
  const leave = data.leave || {
    cpN1Acquis: parseFloat(employeeInfo.congesN1) || 0,
    cpNAcquis: parseFloat(employeeInfo.congesN) || 0,
    rttAcquis: parseFloat(employeeInfo.rtt) || 0,
    congesPris: 0,
    rttPris: 0,
    cumulCongesPris: 0,
    cumulRttPris: 0,
    cpN1Solde: parseFloat(employeeInfo.congesN1) || 0,
    cpNSolde: parseFloat(employeeInfo.congesN) || 0,
    rttSolde: parseFloat(employeeInfo.rtt) || 0,
  }

  textRight(formatMontant(leave.cpN1Acquis), rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight(formatMontant(leave.cpNAcquis), rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  if (avecRtt) textRight(formatMontant(leave.rttAcquis), rightX + gridW - 2, rightY + 2.4)
  rightY += 3.5

  // Pris row
  drawRect(rightX, rightY, gridW, 3.5)
  doc.text('Pris (cumul)', rightX + 2, rightY + 2.4)
  const cpN1Pris = Math.min(leave.cpN1Acquis, leave.cumulCongesPris)
  const cpNPris = leave.cumulCongesPris > leave.cpN1Acquis ? leave.cumulCongesPris - leave.cpN1Acquis : 0
  const rttPrisVal = leave.cumulRttPris
  
  textRight(formatMontant(cpN1Pris), rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight(formatMontant(cpNPris), rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  if (avecRtt) textRight(formatMontant(rttPrisVal), rightX + gridW - 2, rightY + 2.4)
  rightY += 3.5

  // Solde row
  fillRect(rightX, rightY, gridW, 3.5, LIGHT_GRAY)
  drawRect(rightX, rightY, gridW, 3.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Solde disponible', rightX + 2, rightY + 2.4)
  textRight(formatMontant(leave.cpN1Solde), rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight(formatMontant(leave.cpNSolde), rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  if (avecRtt) textRight(formatMontant(leave.rttSolde), rightX + gridW - 2, rightY + 2.4)
  rightY += 8

  // Box D: Cumuls
  fillRect(rightX, rightY, gridW, 3.8, LIGHT_GRAY)
  drawRect(rightX, rightY, gridW, 3.8)
  doc.setFontSize(6.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text(`Cumuls depuis Janvier ${year}`, rightX + 2.5, rightY + 2.6)
  rightY += 3.8

  const cumuls = data.cumuls || { brut: 0, netImposable: 0, irPreleve: 0, heures: 0 }
  const cumulItems = [
    { label: 'Salaire brut cumulé :', val: `${formatMontant(cumuls.brut)} €`, color: BLACK },
    { label: 'Net imposable cumulé :', val: `${formatMontant(cumuls.netImposable)} €`, color: BLACK },
    { label: 'Impôt à la source prélevé :', val: `-${formatMontant(cumuls.irPreleve)} €`, color: DANGER_RED },
    { label: 'Temps travaillé cumulé :', val: `${formatMontant(cumuls.heures)} h`, color: BLACK }
  ]

  drawRect(rightX, rightY, gridW, 20)
  doc.setFontSize(6)
  cumulItems.forEach((item, idx) => {
    doc.setFont('helvetica', 'normal')
    setColor(GRAY)
    doc.text(item.label, rightX + 3, rightY + 4 + idx * 4.5)
    doc.setFont('helvetica', 'bold')
    setColor(item.color)
    textRight(item.val, rightX + gridW - 3, rightY + 4 + idx * 4.5)
  })

  // ═══ 5. FOOTER NET PAYÉ BOX (PINNED AT THE BOTTOM LIMIT) ═══
  const footerY = 258
  drawLine(margin, footerY, margin + contentW, footerY, 0.2)

  // Payment details (Left side of footer)
  doc.setFontSize(6)
  doc.setFont('helvetica', 'normal')
  setColor(GRAY)
  doc.text('Mode de paiement :', margin, footerY + 5)
  doc.text('Date de paiement :', margin, footerY + 9)
  
  setColor(BLACK)
  doc.setFont('helvetica', 'bold')
  doc.text(data.modePaiement || employerInfo.modePaiement || 'Virement bancaire', margin + 24, footerY + 5)
  doc.text(datePaie, margin + 24, footerY + 9)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(5.2)
  setColor(GRAY)
  doc.text('Net payé = rémunération brute (1) - total des cotisations et contributions salariales (4) - impôt prélevé à la source (5)', margin, footerY + 14)

  // Numérotation de page
  // Seulement s'il y a plusieurs pages : « Page 1/1 » était dessiné SOUS
  // l'encadré du net payé (texte caché, signal classique de document retouché).
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; totalPages > 1 && p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFontSize(5.5)
    doc.setFont('helvetica', 'normal')
    setColor(GRAY)
    textRight(`Page ${p}/${totalPages}`, margin + contentW, footerY + 14)
  }

  // Net Payé Box (Right side of footer)
  const netBoxW = 70
  const netBoxH = 16
  const netBoxX = margin + contentW - netBoxW
  const netBoxY = footerY + 2

  let netBoxBgColor = SECONDARY
  let netBoxTextColor = PRIMARY
  if (template === 'minimalist') {
    netBoxBgColor = PRIMARY
    netBoxTextColor = WHITE
  }

  doc.setFillColor(netBoxBgColor[0], netBoxBgColor[1], netBoxBgColor[2])
  doc.rect(netBoxX, netBoxY, netBoxW, netBoxH, 'F')
  doc.setDrawColor(BORDER_GRAY[0], BORDER_GRAY[1], BORDER_GRAY[2])
  doc.setLineWidth(0.15)
  doc.rect(netBoxX, netBoxY, netBoxW, netBoxH, 'S')

  // Label
  doc.setFontSize(6.2)
  doc.setFont('helvetica', 'bold')
  if (template === 'minimalist') {
    doc.setTextColor(200, 200, 200)
  } else {
    doc.setTextColor(GRAY[0], GRAY[1], GRAY[2])
  }
  doc.text('NET PAYÉ EN EUROS', netBoxX + 4, netBoxY + 5)

  // Amount
  doc.setFontSize(11)
  doc.setFont('helvetica', 'bold')
  doc.setTextColor(netBoxTextColor[0], netBoxTextColor[1], netBoxTextColor[2])
  textRight(`${formatMontant(data.netAPayer)} €`, netBoxX + netBoxW - 4, netBoxY + 11.5)

  // ═══ 6. FOOTER LEGAL MENTION ═══
  doc.setFontSize(6)
  doc.setFont('helvetica', 'italic')
  setColor(GRAY)
  const legalText = 'Dans votre intérêt et pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.'
  const legalW = doc.getTextWidth(legalText)
  doc.text(legalText, margin + (contentW - legalW) / 2, 286)

  // Filigrane SPÉCIMEN — aperçu / téléchargement NON payé. Diagonal, semi-transparent,
  // répété sur toute la hauteur : montre la mise en page mais rend le document
  // inutilisable comme vrai bulletin. Le PDF payé (serveur) passe watermark:false.
  // GState (opacité) n'est utilisé QUE côté navigateur (le serveur ne filigrane jamais).
  if (options.watermark) {
    doc.saveGraphicsState()
    try {
      doc.setGState(new doc.GState({ opacity: 0.13 }))
    } catch { /* GState indisponible : on retombe sur un gris clair opaque */ }
    doc.setTextColor(90, 90, 90)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(58)
    for (const yPos of [70, 120, 170, 220, 270]) {
      doc.text('SPÉCIMEN — NON PAYÉ', 105, yPos, { angle: 33, align: 'center' })
    }
    doc.restoreGraphicsState()
  }

  return doc
}

// ═════════════════════════════════════════════════════════════════════════════
// MODÈLE « TRADITIONNEL » — rendu monospace type éditeur SIRH (SAP / Sage / ADP)
//
// Géométrie relevée au point sur un bulletin A4 de référence (595 × 842 pt) puis
// convertie en millimètres (unité du document jsPDF). Signature visuelle :
//   • corps intégralement en Courier (police standard jsPDF, rien à embarquer) ;
//   • 5 colonnes propres, en-tête sur bandeau bleu ciel, texte blanc ;
//   • rubriques de cotisation en CAPITALES, sans encadré ;
//   • signe négatif SUFFIXÉ (« 63,06- »), convention des éditeurs de paie ;
//   • pagination à en-tête intégralement répété, totaux sur la DERNIÈRE page
//     seulement (les cases restent dessinées mais vides sur les précédentes) ;
//   • aucun logo — le bloc employeur est entièrement textuel.
//
// Les libellés sans équivalent dans Salareo (codes de rubrique propres à chaque
// SIRH, filière, affectation, structure) sont volontairement laissés VIDES
// plutôt que remplis avec une valeur plausible : la mise en page est reproduite,
// jamais les données.
// ═════════════════════════════════════════════════════════════════════════════

/** Palette relevée dans le PDF de référence (opérateurs `rg`). */
const TRAD_NAVY = [0, 32, 96]      // #002060 — titres
const TRAD_BLUE = [0, 87, 161]     // #0057A1 — libellés de bandeau, mention de pied
const TRAD_SKY = [117, 196, 255]   // #75C4FF — fonds de bandeau
const TRAD_RULE = [150, 190, 225]  // filets du tableau

/** Géométrie (mm). Les `R*` sont des bords DROITS d'alignement des nombres. */
const T = {
  X0: 6.35, X1: 203.55,
  C1: 93.85, C2: 116.77, C3: 139.70, C4: 172.16,   // bordures internes
  R1: 113.5, R2: 137.9, R3: 170.3, R4: 196.4,      // alignements droite (mesurés sur l'original ; R4 nettement en retrait du bord — marge de sécurité voulue par le gabarit source, PAS un oubli)
  CODE_R: 21.0, LABEL_X: 29.1, CAT_X: 12.8, SUB_X: 30.6, PERIOD_X: 76.0,
  EMP_X: 120.0,                                     // bloc salarié (droite)
  LBL_COL: 34.6, VAL_COL: 36.6,                     // « LABEL  : valeur »
  BAND_TOP: 95.6, BAND_H: 4.2, HEAD_BASE: 98.6,
  BODY_TOP: 103.3, BODY_BOTTOM: 228.0, LINE_H: 2.84,
  NET_Y: 232.0, IR_TOP: 242.0, NETBOX_TOP: 252.0,
  RECAP_TOP: 263.5, ROW_H: 6.0,
  FOOT_Y: 285.8, CODE_Y: 291.0,
}

/**
 * Protection anti-crash : jsPDF lève sur un texte OU une coordonnée
 * null/undefined/NaN. `buildPdfDoc` applique ce correctif à son propre document ;
 * ce rendu n'empruntant pas son corps, il doit le réappliquer au sien.
 */
function patchTradText(doc) {
  const raw = doc.text.bind(doc)
  doc.text = (text, x, y, opts) => {
    const clean = (t) => (t == null || (typeof t === 'number' && Number.isNaN(t))) ? '' : String(t)
    const safe = Array.isArray(text) ? text.map(clean) : clean(text)
    const sx = (typeof x !== 'number' || Number.isNaN(x)) ? 0 : x
    const sy = (typeof y !== 'number' || Number.isNaN(y)) ? 0 : y
    return opts ? raw(safe, sx, sy, opts) : raw(safe, sx, sy)
  }
}

/** Montant au format SIRH : signe négatif SUFFIXÉ. Chaîne vide si nul/absent. */
function fmtTrad(value, keepZero = false) {
  const n = parseFloat(value)
  if (!Number.isFinite(n) || (!keepZero && n === 0)) return ''
  return formatMontant(Math.abs(n)) + (n < 0 ? '-' : '')
}

function buildTraditionnelDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options = {}) {
  const doc = new JsPDF('p', 'mm', 'a4')
  patchTradText(doc)

  const emp = employerInfo || {}
  const sal = employeeInfo || {}
  const lastDay = new Date(year, month + 1, 0).getDate()
  const mm2 = String(month + 1).padStart(2, '0')
  const periodStart = data.proration?.periodeDebut || `01/${mm2}/${year}`
  const periodEnd = data.proration?.periodeFin || `${lastDay}/${mm2}/${year}`
  const datePaie = datePaiementDe(data, month, year, periodEnd)
  const shortPeriod = `${mm2}/${String(year).slice(2)}`

  // ── Primitives ────────────────────────────────────────────────────────────
  const mono = (size = 7, style = 'normal') => { doc.setFont('courier', style); doc.setFontSize(size) }
  const sans = (size = 7, style = 'normal') => { doc.setFont('helvetica', style); doc.setFontSize(size) }
  const ink = (c) => doc.setTextColor(c[0], c[1], c[2])
  const fill = (x, y, w, h, c) => { doc.setFillColor(c[0], c[1], c[2]); doc.rect(x, y, w, h, 'F') }
  const stroke = (x, y, w, h, c = TRAD_RULE, lw = 0.2) => {
    doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(lw); doc.rect(x, y, w, h, 'S')
  }
  const rule = (x1, y1, x2, y2, c = TRAD_RULE, lw = 0.2) => {
    doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2)
  }
  const right = (txt, x, y) => { const s = txt == null ? '' : String(txt); doc.text(s, x - doc.getTextWidth(s), y) }
  const center = (txt, x, y) => { const s = txt == null ? '' : String(txt); doc.text(s, x - doc.getTextWidth(s) / 2, y) }
  /** Tronque à une largeur mm donnée (Courier : avance fixe = 0.6 × corps). */
  const clip = (str, maxMm, size = 7) => {
    const per = size * 0.6 * 0.352778
    const max = Math.max(1, Math.floor(maxMm / per))
    const s = String(str || '')
    return s.length <= max ? s : s.slice(0, max - 1) + '.'
  }
  /** « LABEL            : valeur » — deux-points alignés comme sur l'original. */
  const kv = (label, value, y, x = 8) => {
    mono(7); ink([0, 0, 0])
    doc.text(String(label || ''), x, y)
    doc.text(':', T.LBL_COL, y)
    doc.text(String(value == null ? '' : value), T.VAL_COL, y)
  }

  // ── Lignes du corps ───────────────────────────────────────────────────────
  // kind: 'item' (élément chiffré) | 'cat' (rubrique) | 'gap' | 'rule'
  const rows = []
  const item = (o) => rows.push({ kind: 'item', ...o })
  const gap = () => rows.push({ kind: 'gap' })

  item({ label: 'Rémunération de base', period: shortPeriod, base: data.horaireMensuel, taux: data.tauxHoraire, salAmt: data.salaireBase })

  if (data.heuresSuppLignes && data.heuresSuppLignes.length > 0) {
    data.heuresSuppLignes.forEach((l) => {
      if ((l.heures || 0) > 0) {
        item({ label: l.label || `Heures supp. ${l.tauxMult}%`, base: l.heures, taux: l.computedTauxHS, salAmt: l.brut })
      }
    })
  } else if (data.heuresSupp > 0) {
    item({ label: 'Heures supplémentaires', base: data.heuresSupp, taux: data.tauxHS, salAmt: data.hsBrut })
  }

  if (data.primes && data.primes.length > 0) {
    data.primes.forEach((p) => { if ((p.montant || 0) > 0) item({ label: p.label || 'Prime', salAmt: p.montant }) })
  } else if (data.primeExceptionnelle > 0) {
    item({ label: 'Prime exceptionnelle', salAmt: data.primeExceptionnelle })
  }
  const cpTrad = lignesCongesPayes(data)
  if (cpTrad) {
    item({ label: cpTrad.absenceCourt, base: cpTrad.jours, salAmt: -cpTrad.retenue })
    item({ label: cpTrad.indemnite, base: cpTrad.jours, salAmt: cpTrad.montant })
  }

  item({ label: 'Total Brut', salAmt: data.totalBrut, bold: true })
  gap()

  let cat = null
  fusionCsgPsc(data.cotisations).forEach((c) => {
    if (c.category !== cat) { cat = c.category; rows.push({ kind: 'cat', label: c.category }) }
    item({
      label: libelleOfficiel(c.name), sub: true,
      base: c.base, taux: tauxSalAffiche(c),
      salAmt: c.partSal > 0 ? -c.partSal : 0,
      patAmt: c.partPat > 0 ? -c.partPat : 0,
    })
  })

  const exoTrad = exonerationsReparties(data)
  if (exoTrad.sal || exoTrad.pat) {
    gap()
    item({ label: 'EXONERATIONS ET ALLEGEMENTS DE COTISATIONS :', cap: true, salAmt: exoTrad.sal, patAmt: exoTrad.pat })
  }

  gap()
  item({
    label: 'TOTAL DES COTISATIONS ET CONTRIBUTIONS :', cap: true,
    salAmt: -(data.totalCotisSal || 0), patAmt: -(data.totalCotisPat || 0),
  })
  gap()
  item({ label: 'Montant net social', salAmt: data.netSocial })

  // ── Tenue sur UNE page (exigence produit) ─────────────────────────────────
  // Le bulletin de référence déborde sur une 2ᵉ page ; ici on garde une page
  // unique en resserrant l'interligne, et le corps du texte avec lui pour que
  // les glyphes ne se chevauchent jamais. Au-delà du plancher de lisibilité on
  // ne descend plus (cas pathologique : le contenu déborderait alors du cadre,
  // ce que les plafonds de saisie de l'UI — 8 HS / 8 primes — rendent
  // inatteignable en pratique).
  const AVAIL = T.BODY_BOTTOM - T.BODY_TOP
  const lineH = rows.length > 0 ? Math.min(T.LINE_H, AVAIL / rows.length) : T.LINE_H
  const bodySize = Math.max(4.6, Math.min(7, (lineH / T.LINE_H) * 7))

  // ── En-tête (répété intégralement sur chaque page) ─────────────────────────
  function drawHeader() {
    sans(11, 'bold'); ink(TRAD_NAVY)
    right('BULLETIN DE PAIE', 197.8, 9.9)

    mono(7); ink([0, 0, 0])
    doc.text(clip(emp.nom || '', 60), 32.3, 26.7)
    const adr = [emp.adresse, [emp.codePostal, emp.ville].filter(Boolean).join(' ')].filter(Boolean).join(' ')
    doc.text(clip(`SIEGE SOCIAL : ${adr}`, 130), T.X0, 29.5)
    doc.text('-'.repeat(59), T.X0, 32.1)

    // Convention collective (gauche) + identité du salarié (droite)
    const ccnLignes = doc.splitTextToSize(`CCN  ${conventionMention(emp)}`, 100)
    ccnLignes.slice(0, 2).forEach((l, i) => doc.text(i === 1 ? clip(ccnLignes.slice(1).join(' '), 100) : l, T.X0, 46.5 + i * 2.8))

    const civil = sal.sexe === 'F' ? 'Mme' : sal.sexe === 'M' ? 'M.' : ''
    doc.text(clip([civil, sal.prenom, (sal.nom || '').toUpperCase()].filter(Boolean).join(' '), 78), T.EMP_X, 43.7)
    doc.text(clip(sal.adresse || '', 78), T.EMP_X, 46.5)
    doc.text(clip([sal.codePostal, sal.ville].filter(Boolean).join(' '), 78), T.EMP_X, 51.9)

    // Bloc caractéristiques — uniquement les champs réellement renseignés.
    let yy = 55.1
    const line = (l, v) => { if (v !== '' && v != null) { kv(l, v, yy); yy += 2.82 } }
    line('MATRICULE', sal.matricule || '')
    line('ANCIENNETE', formatDateFR(sal.dateEntree))
    if (sal.niveau || sal.coefficient) line('NIVEAU /COEFF.', [sal.niveau, sal.coefficient].filter(Boolean).join('   '))
    line('QUALIFICATION', sal.statut || '')
    line('EMPLOI', sal.emploi || '')
    if (sal.echelon) line('ECHELON', sal.echelon)
    line('HORAIRE', `${formatMontant(data.horaireMensuel)} Heures`)

    kv('N° S.S.', sal.numSecu || '', 83.3)

    mono(7)
    const siret = formatSiretTrad(emp.siret)
    doc.text(clip(`SIRET : ${siret}    NAF : ${emp.codeAPE || ''}`, 110), T.X0, 92.0)
    doc.text(`PERIODE ${periodStart} ${periodEnd}`, 140.0, 88.9)
    doc.text(`DATE DE PAIE : ${datePaie}`, 140.0, 92.0)

    // Bandeau des colonnes
    fill(T.X0, T.BAND_TOP, T.X1 - T.X0, T.BAND_H, TRAD_SKY)
    sans(5.6, 'bold'); ink([255, 255, 255])
    center('ELEMENTS DE PAIE', (T.X0 + T.C1) / 2, T.HEAD_BASE)
    center('NBRE OU BASE', (T.C1 + T.C2) / 2, T.HEAD_BASE)
    center('TAUX SALARIAL', (T.C2 + T.C3) / 2, T.HEAD_BASE)
    center('PART SALARIALE', (T.C3 + T.C4) / 2, T.HEAD_BASE)
    center('PART EMPLOYEUR', (T.C4 + T.X1) / 2, T.HEAD_BASE)

    // Cadre + séparateurs verticaux, jusqu'au bas de la zone de saisie
    stroke(T.X0, T.BAND_TOP, T.X1 - T.X0, T.BODY_BOTTOM - T.BAND_TOP)
    ;[T.C1, T.C2, T.C3, T.C4].forEach((x) => rule(x, T.BAND_TOP, x, T.BODY_BOTTOM))

    // Mention verticale en marge droite (comme sur l'original)
    sans(6.4); ink(TRAD_NAVY)
    doc.text('Pour faire valoir vos droits, conservez ce document sans limitation de durée',
      T.X1 + 4.2, T.BODY_BOTTOM - 2, { angle: 90 })
  }

  // ── Corps ─────────────────────────────────────────────────────────────────
  function drawBody() {
    let yy = T.BODY_TOP
    rows.forEach((r) => {
      if (r.kind === 'gap') { yy += lineH; return }
      if (r.kind === 'cat') {
        mono(bodySize); ink([0, 0, 0])
        doc.text(clip(String(r.label || '').toUpperCase(), 78, bodySize), T.CAT_X, yy)
        yy += lineH
        return
      }
      mono(bodySize, r.bold ? 'bold' : 'normal'); ink([0, 0, 0])
      if (r.code) right(String(r.code), T.CODE_R, yy)
      const x = r.cap ? T.CAT_X : (r.sub ? T.SUB_X : T.LABEL_X)
      doc.text(clip(r.label, T.C1 - x - 2, bodySize), x, yy)
      if (r.period) doc.text(r.period, T.PERIOD_X, yy)
      right(fmtTrad(r.base), T.R1, yy)
      right(formatTaux(r.taux), T.R2, yy)
      right(fmtTrad(r.salAmt), T.R3, yy)
      right(fmtTrad(r.patAmt), T.R4, yy)
      yy += lineH
    })
  }

  // ── Pied : totaux, impôt, net, récapitulatif ──────────────────────────────
  function drawFooter(filled) {
    // NET À PAYER AVANT IMPÔT
    sans(8, 'bold'); ink(TRAD_NAVY)
    doc.text('NET A PAYER AVANT IMPOT SUR LE REVENU', T.X0, T.NET_Y)
    if (filled) { mono(7.6, 'bold'); ink([0, 0, 0]); right(fmtTrad(data.netAvantIR, true), T.R3, T.NET_Y) }

    // L'ancien bandeau « Dont évolution de la rémunération… » était imprimé SANS
    // montant (ligne facultative depuis l'arrêté de 2023, BOSS question 5) : retiré.

    // Bloc impôt sur le revenu — bandeau bleu sur « libellé + Base » et sur
    // « Montant », zone blanche au milieu (emplacement du taux personnalisé).
    const irH = 4.6
    fill(T.X0, T.IR_TOP, T.C2 - T.X0, irH, TRAD_SKY)
    fill(T.C4, T.IR_TOP, T.X1 - T.C4, irH, TRAD_SKY)
    sans(5.2, 'bold'); ink(TRAD_NAVY)
    doc.text('IMPOT SUR LE REVENU', T.X0 + 1, T.IR_TOP + 3.1)
    center('Base', (T.C1 + T.C2) / 2, T.IR_TOP + 3.1)
    center('Montant', (T.C4 + T.X1) / 2, T.IR_TOP + 3.1)
    stroke(T.X0, T.IR_TOP, T.X1 - T.X0, irH * 2)
    rule(T.X0, T.IR_TOP + irH, T.X1, T.IR_TOP + irH)
    ;[T.C1, T.C2, T.C4].forEach((x) => rule(x, T.IR_TOP, x, T.IR_TOP + irH * 2))
    sans(5.2, 'bold'); ink(TRAD_NAVY)
    doc.text('IMPOT SUR LE REVENU PRELEVE A LA SOURCE', T.X0 + 1, T.IR_TOP + irH + 3.1)
    if (filled) {
      mono(7); ink([0, 0, 0])
      right(fmtTrad(data.baseIR, true), T.C2 - 2, T.IR_TOP + irH + 3.1)
      const tx = formatTaux(data.tauxIR)
      sans(7); ink(TRAD_NAVY)
      center(tx ? 'TAUX PERSONNALISE' : 'TAUX NON PERSONNALISE', (T.C2 + T.C4) / 2, T.IR_TOP + 3.1)
      mono(7); ink([0, 0, 0])
      right(tx ? `${tx} %` : formatTaux(0) || '0,00', T.C4 - 2, T.IR_TOP + irH + 3.1)
      right(fmtTrad(data.irPreleve, true), T.R4, T.IR_TOP + irH + 3.1)
      // Compteurs de congés — bande libre à GAUCHE du bloc « NET A PAYER »
      // (qui commence à T.C1+8). Le gabarit n'affichait aucun congé jusqu'ici :
      // seule la colonne « BRUT CONGES PAYES » du récapitulatif existait, et
      // elle reste vide (voir plus bas). Les soldes sont pourtant une mention
      // attendue sur un bulletin — ajoutés le 26/08/2026.
      const lv = data.leave
      if (lv) {
        const cy = T.IR_TOP + irH * 2 + 2.4      // sous le tableau impôt, avec de l'air
        const LH = 2.1                            // 4 lignes -> 8.4 mm ; MODE DE REGLEMENT suit à RECAP_TOP-1.6
        const cX = [T.X0, 44, 60, 78]             // libellé, acquis, pris, solde (alignés à droite)
        sans(4.6, 'bold'); ink(TRAD_NAVY)
        const avecRttT = (lv.rttAcquis || 0) > 0 || (lv.cumulRttPris || 0) > 0
        doc.text(avecRttT ? 'CONGES PAYES ET RTT (en jours)' : 'CONGES PAYES (en jours)', cX[0], cy)
        right('ACQUIS', cX[1], cy); right('PRIS', cX[2], cy); right('SOLDE', cX[3], cy)
        // « Pris » = cumul depuis le début de la période de référence, ventilé
        // N-1 d'abord puis N — même règle que le moteur (calculations.js) et
        // que l'autre modèle de bulletin, pour ne pas afficher deux vérités.
        const prisN1 = Math.min(lv.cpN1Acquis, lv.cumulCongesPris)
        const prisN = lv.cumulCongesPris > lv.cpN1Acquis ? lv.cumulCongesPris - lv.cpN1Acquis : 0
        const lignes = [
          ['CP N-1', lv.cpN1Acquis, prisN1, lv.cpN1Solde],
          ['CP N', lv.cpNAcquis, prisN, lv.cpNSolde],
          ['RTT', lv.rttAcquis, lv.cumulRttPris, lv.rttSolde],
        ].filter((r) => r[0] !== 'RTT' || avecRttT)
        lignes.forEach((r, i) => {
          const y = cy + LH * (i + 1)
          mono(5); ink([0, 0, 0])
          doc.text(String(r[0]), cX[0], y)
          right(formatMontant(r[1]), cX[1], y)
          right(formatMontant(r[2]), cX[2], y)
          mono(5, 'bold')
          right(formatMontant(r[3]), cX[3], y)
        })
      }

      // Mode de règlement — descendu sous les compteurs de congés (il occupait
      // auparavant l'emplacement que ceux-ci prennent désormais).
      const mode = data.modePaiement || emp.modePaiement || 'VIREMENT'
      mono(6.4); ink([0, 0, 0])
      doc.text(`MODE DE REGLEMENT : ${String(mode).toUpperCase()}`, T.X0, T.RECAP_TOP - 1.6)

      // Montant net des heures sup./compl. exonérées d'impôt (art. 81 quater
      // CGI, libellé de l'arrêté du 31/01/2023). Pas de place dans le bloc
      // impôt — l'encadré NET A PAYER est collé dessous — donc sur la bande
      // libre à droite du mode de règlement, alignée sur l'encadré du net.
      const hsMois = data.montantNetHSExonere || 0
      const hsCumul = data.cumuls?.hsExonere || 0
      if (hsMois > 0 || hsCumul > 0) {
        right(`MONTANT NET DES HEURES COMPL/SUPPL EXONEREES : ${fmtTrad(hsMois, true)}  (CUMUL ${fmtTrad(hsCumul, true)})`, T.C4 + 33.5, T.RECAP_TOP - 1.6)
      }
    }

    // Encadré NET À PAYER EN EUROS
    const boxY = T.NETBOX_TOP, boxH = 7.4
    fill(T.C1 + 8, boxY, 56, boxH, TRAD_SKY)
    doc.setDrawColor(TRAD_NAVY[0], TRAD_NAVY[1], TRAD_NAVY[2]); doc.setLineWidth(0.5)
    doc.rect(T.C1 + 8, boxY, 56, boxH, 'S')
    doc.rect(T.C4 - 6.5, boxY, 40, boxH, 'S')
    sans(7.4, 'bold'); ink(TRAD_NAVY)
    center('NET A PAYER EN EUROS', T.C1 + 36, boxY + 4.9)
    if (filled) { mono(9, 'bold'); ink([0, 0, 0]); right(formatMontant(data.netAPayer), T.C4 + 28, boxY + 5.1) }
    sans(6, 'bold'); ink(TRAD_NAVY)
    doc.text('€', T.C4 + 29.5, boxY + 3.4)

    // Récapitulatif MOIS / CUMUL
    const cw = [0, 26.5, 26.5, 26.5, 26.5, 26.5, 27.5, 27.5]
    const xs = [T.X0 + 16]
    for (let i = 1; i < cw.length; i++) xs.push(xs[i - 1] + cw[i])
    const heads = ['BRUT', 'COTISATIONS\nSALARIALES', 'COTISATIONS\nPATRONALES', 'NET IMPOSABLE',
      'BRUT CONGES PAYES', 'Exonérations et\nallègements', 'Total versé par l\'employeur']
    const hH = 5.6
    fill(xs[0], T.RECAP_TOP, xs[7] - xs[0], hH, TRAD_SKY)
    sans(4.5, 'bold'); ink(TRAD_NAVY)
    heads.forEach((h, i) => {
      const parts = String(h).split('\n')
      parts.forEach((p, k) => center(p, (xs[i] + xs[i + 1]) / 2, T.RECAP_TOP + (parts.length === 1 ? 3.6 : 2.4 + k * 2.1)))
    })
    const r1y = T.RECAP_TOP + hH, r2y = r1y + 5.4
    fill(T.X0, r1y, 16, 5.4, TRAD_SKY); fill(T.X0, r2y, 16, 5.4, TRAD_SKY)
    sans(5, 'bold'); ink(TRAD_NAVY)
    doc.text('MOIS', T.X0 + 1.5, r1y + 3.6)
    doc.text('CUMUL', T.X0 + 1.5, r2y + 3.6)
    stroke(T.X0, T.RECAP_TOP, xs[7] - T.X0, hH + 10.8)
    rule(T.X0, r1y, xs[7], r1y); rule(T.X0, r2y, xs[7], r2y)
    rule(T.X0 + 16, T.RECAP_TOP, T.X0 + 16, r2y + 5.4)
    xs.slice(1, 7).forEach((x) => rule(x, T.RECAP_TOP, x, r2y + 5.4))

    if (filled) {
      const cum = data.cumuls || {}
      mono(6.4); ink([0, 0, 0])
      // Le `null` en 5e position = colonne « BRUT CONGES PAYES ». Elle reste
      // VIDE : l'indemnité du mois est imprimée dans le corps (lignes « Absence
      // CP » / « Indemnité de congés payés », depuis le 11/10/2026) mais le
      // moteur n'en tient pas de cumul annuel — n'afficher que le mois serait
      // incohérent avec la ligne CUMUL. Compteurs en JOURS plus haut.
      const mois = [data.totalBrut, data.totalCotisSal, data.totalCotisPat, data.baseIR, null, data.totalAllegements, data.totalVerseEmployeur]
      const cumul = [cum.brut, cum.cotisSal, cum.cotisPat, cum.netImposable, null, cum.allegements, cum.totalVerse]
      mois.forEach((v, i) => { if (v != null) right(fmtTrad(v, true), xs[i + 1] - 1.5, r1y + 3.7) })
      cumul.forEach((v, i) => { if (v != null) right(fmtTrad(v, true), xs[i + 1] - 1.5, r2y + 3.7) })
    }

    // Pied de page
    sans(5.6); ink(TRAD_BLUE)
    center(MENTION_SERVICE_PUBLIC, 105, T.FOOT_Y)
    mono(6); ink([0, 0, 0])
    const ref = [sal.matricule || '', (sal.nom || '').toUpperCase(), sal.prenom || '', periodEnd].filter(Boolean).join('   ')
    doc.text(clip(ref, 190, 6), T.X0, T.CODE_Y)
  }

  drawHeader()
  drawBody()
  drawFooter(true)

  // Filigrane d'aperçu non payé — même dispositif que buildPdfDoc. Inopérant
  // sous Deno (GState absent) : le serveur ré-appose son propre tampon.
  if (options.watermark) {
    const n = doc.getNumberOfPages()
    for (let p = 1; p <= n; p++) {
      doc.setPage(p)
      try { doc.setGState(new doc.GState({ opacity: 0.13 })) } catch { /* Deno : ignoré */ }
      doc.setTextColor(180, 40, 40); doc.setFont('helvetica', 'bold'); doc.setFontSize(30)
      for (let k = 0; k < 5; k++) doc.text('SPÉCIMEN — NON PAYÉ', 22, 60 + k * 52, { angle: 33 })
      try { doc.setGState(new doc.GState({ opacity: 1 })) } catch { /* Deno : ignoré */ }
    }
  }

  return doc
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODÈLE « CABINET » — grille monospace + calendrier journalier.

   Reproduit la mise en page des bulletins émis par les logiciels de cabinets
   d'expertise comptable : grille à 5 colonnes en Courier, rubriques en
   capitales grasses, totaux à points de conduite numérotés (1)(2)(4) qui
   composent la formule du net, colonne « INFORMATIONS JOURNALIERES » jour par
   jour, récapitulatif fiscal DU MOIS / DEPUIS, compteurs de congés.

   Décodé le 14/09/2026 sur un bulletin de référence fourni par un prospect —
   STRUCTURE uniquement : aucune valeur, aucun nom, aucun logo n'en est repris.

   Nombres : l'original est imprimé sur un formulaire pré-imprimé dont la
   ligne des décimales est tracée sur le papier — les chiffres sont posés de
   part et d'autre, sans virgule. On reproduit ce dispositif : un filet
   vertical fin par colonne numérique, entier à gauche, deux décimales à
   droite, signe négatif SUFFIXÉ (« 8668- » = −86,68), pas de séparateur de
   milliers. Le bloc congés, lui, est en clair avec virgule — comme sur
   l'original, où il est hors formulaire.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Dimanche de Pâques (calendrier grégorien) — algorithme de Meeus/Jones/Butcher. */
function dimanchePaques(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(year, month - 1, day)
}

/**
 * Jours fériés légaux de France métropolitaine (art. L.3133-1 du Code du
 * travail) — 11 jours. Les jours propres à l'Alsace-Moselle (Vendredi saint,
 * 26 décembre) et aux DOM ne sont PAS inclus. Renvoie un Set 'YYYY-MM-DD'.
 */
export function joursFeries(year) {
  const p = dimanchePaques(year)
  const plus = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
  const fixes = [[0, 1], [4, 1], [4, 8], [6, 14], [7, 15], [10, 1], [10, 11], [11, 25]]
  const dates = fixes.map(([m, d]) => new Date(year, m, d))
  dates.push(plus(p, 1), plus(p, 39), plus(p, 50)) // lundi de Pâques, Ascension, lundi de Pentecôte
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return new Set(dates.map(key))
}

/**
 * Calendrier journalier d'un mois de paie, tel qu'affiché par le modèle
 * « cabinet ». Une entrée par jour civil :
 * { jour, lettre, heures, incident, heuresIncident }.
 *
 * ⚠️ HORAIRE THÉORIQUE, pas un relevé de pointage. Le moteur mensualise la
 * paie sur l'horaire contractuel sans connaître la répartition réelle des
 * heures : on affiche donc l'horaire contractuel réparti du lundi au vendredi
 * (horaire mensuel × 12 / 52 / 5 — 7,00 h/j pour 151,67 h), rien le week-end,
 * « JF » sur les jours fériés légaux tombant en semaine (jour férié chômé),
 * et rien hors période de présence (entrée/sortie en cours de mois). Depuis le
 * 11/10/2026, les congés payés datés (`opts.congesDebut/congesFin`, ISO) sont
 * marqués « CP » et les absences non rémunérées DATÉES (`opts.absences`,
 * debut/fin) « AB » sur leurs jours ouvrés ; une absence sans dates n'est pas
 * reportée — plutôt que de la placer sur des jours inventés.
 */
export function calendrierMois(year, month, horaireMensuel, opts = {}) {
  const feries = joursFeries(year)
  const lastDay = new Date(year, month + 1, 0).getDate()
  const hJour = Math.round(((parseFloat(horaireMensuel) || 0) * 12 / 52 / 5) * 100) / 100
  const jourKey = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
  const debut = opts.presenceStart ? jourKey(opts.presenceStart) : null
  const fin = opts.presenceEnd ? jourKey(opts.presenceEnd) : null
  const LETTRES = ['D', 'L', 'M', 'M', 'J', 'V', 'S']
  const out = []
  for (let d = 1; d <= lastDay; d++) {
    const date = new Date(year, month, d)
    const t = date.getTime()
    const dow = date.getDay()
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const present = (debut == null || t >= debut) && (fin == null || t <= fin)
    const weekend = dow === 0 || dow === 6
    let heures = 0, incident = '', heuresIncident = 0
    const enConges = !!(opts.congesDebut && opts.congesFin) && key >= String(opts.congesDebut).slice(0, 10) && key <= String(opts.congesFin).slice(0, 10)
    // Absence non rémunérée DATÉE (retenue sur le salaire) : jour en incident « AB »,
    // pas en heures de travail.
    const enAbsence = (opts.absences || []).some((a) => (parseFloat(a.heures) || 0) > 0 && a.debut && a.fin
      && key >= String(a.debut).slice(0, 10) && key <= String(a.fin).slice(0, 10))
    if (present && !weekend) {
      if (feries.has(key)) { incident = 'JF'; heuresIncident = hJour } // férié chômé payé : la journée est comptée en incident
      else if (enConges) { incident = 'CP'; heuresIncident = hJour }
      else if (enAbsence) { incident = 'AB'; heuresIncident = hJour }
      else heures = hJour
    }
    out.push({ jour: d, lettre: LETTRES[dow], heures, incident, heuresIncident })
  }
  return out
}

/** Capitales sans accents — la casse « mainframe » de ce modèle. */
function capsCab(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
}

const MOIS_CAB = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE']

const CAB = {
  X0: 8, X1: 202,
  // Grille principale (bord droit des colonnes numériques)
  G_X1: 156, C_LBL_END: 88, C_BASE: 106, C_TAUX: 122, C_SAL: 139, C_PAT: 156,
  LABEL_X: 9.5, SUB_X: 11,
  // Calendrier
  K_X0: 158, K_X1: 202, K_TRAV: 187, K_INC: 192,
  // Repères verticaux
  HEAD_TOP: 10, ROW2_Y: 44, EMPLOI_TOP: 65, EMPLOI_H: 14,
  BODY_TOP: 82, BODY_HEAD_H: 9, BODY_BOTTOM: 195, LINE_H: 3.0,
  NET_TOP: 198, NET_H: 15,
  REV_TOP: 216, REV_H: 40,
  CP_TOP: 259, CP_H: 24,
  FOOT_Y: 289,
}
const CAB_INK = [0, 0, 0]
const CAB_RULE = [0, 0, 0]
const CAB_DEC = [170, 170, 170] // filet des décimales (le « pré-imprimé »)

function buildCabinetDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options = {}) {
  const doc = new JsPDF('p', 'mm', 'a4')
  patchTradText(doc)

  const emp = employerInfo || {}
  const sal = employeeInfo || {}
  const lastDay = new Date(year, month + 1, 0).getDate()
  const mm2 = String(month + 1).padStart(2, '0')
  const periodStart = data.proration?.periodeDebut || `01/${mm2}/${year}`
  const periodEnd = data.proration?.periodeFin || `${lastDay}/${mm2}/${year}`
  const datePaie = datePaiementDe(data, month, year, periodEnd)
  const dateLongue = (ddmmyyyy) => {
    const [d, m, y] = String(ddmmyyyy).split('/')
    return `${d} ${MOIS_CAB[parseInt(m, 10) - 1] || ''} ${y}`
  }
  const dateTiret = (ddmmyyyy) => String(ddmmyyyy).replace(/\//g, '-')
  const dateFRcab = (iso) => {
    if (!iso) return ''
    const d = new Date(iso); if (isNaN(d.getTime())) return ''
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
  }

  // ── Primitives ────────────────────────────────────────────────────────────
  const mono = (size = 7, style = 'normal') => { doc.setFont('courier', style); doc.setFontSize(size) }
  const sans = (size = 7, style = 'normal') => { doc.setFont('helvetica', style); doc.setFontSize(size) }
  const ink = (c) => doc.setTextColor(c[0], c[1], c[2])
  const stroke = (x, y, w, h, lw = 0.3, c = CAB_RULE) => {
    doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(lw); doc.rect(x, y, w, h, 'S')
  }
  const rule = (x1, y1, x2, y2, lw = 0.25, c = CAB_RULE) => {
    doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(lw); doc.line(x1, y1, x2, y2)
  }
  const right = (txt, x, y) => { const s = txt == null ? '' : String(txt); doc.text(s, x - doc.getTextWidth(s), y) }
  const center = (txt, x, y) => { const s = txt == null ? '' : String(txt); doc.text(s, x - doc.getTextWidth(s) / 2, y) }
  const chW = (size) => size * 0.6 * 0.352778 // avance fixe Courier, en mm
  const clip = (str, maxMm, size) => {
    const max = Math.max(1, Math.floor(maxMm / chW(size)))
    const s = String(str || '')
    return s.length <= max ? s : s.slice(0, max - 1) + '.'
  }

  /**
   * Nombre « formulaire pré-imprimé » dans une colonne de bord droit `xr` :
   * [entier][filet][2 décimales][signe]. Le signe négatif est suffixé.
   * Renvoie le x gauche de l'entier (pour les points de conduite) ou null.
   */
  const cell = (value, xr, y, size, { keepZero = false, forceNeg = false, dec = 2 } = {}) => {
    const n = parseFloat(value)
    if (!Number.isFinite(n) || (!keepZero && n === 0)) return null
    // `dec` > 2 : la 3e décimale déborde sur la colonne du signe (vide pour un taux).
    const [intPart, decPart] = Math.abs(n).toFixed(dec).split('.')
    const ch = chW(size)
    const signX = xr - ch
    const decX = signX - 2 * ch
    doc.text(decPart, decX, y)
    const intX = decX - 0.5 - doc.getTextWidth(intPart)
    doc.text(intPart, intX, y)
    if (n < 0 || forceNeg) doc.text('-', signX, y)
    return intX
  }
  /** Filet vertical des décimales d'une colonne, sur une hauteur donnée. */
  const decRule = (xr, y0, y1, size) => {
    const x = xr - chW(size) * 3 - 0.25
    rule(x, y0, x, y1, 0.12, CAB_DEC)
  }

  // ═══ EN-TÊTE ═══════════════════════════════════════════════════════════════
  // Gauche : le logo de l'entreprise (data URL, redimensionné à la saisie —
  // voir Entreprise.jsx) dans une zone de 62 × 16 mm, proportions conservées ;
  // à défaut, la raison sociale en grand. Puis l'encadré arrondi de
  // l'établissement, comme sur l'original.
  let logoOk = false
  if (emp.logo && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(emp.logo)) {
    try {
      const pr = doc.getImageProperties(emp.logo)
      const BW = 62, BH = 14
      const k = Math.min(BW / pr.width, BH / pr.height)
      const w = pr.width * k, h = pr.height * k
      doc.addImage(emp.logo, pr.fileType || 'PNG', CAB.X0, CAB.HEAD_TOP - 4 + (BH - h) / 2, w, h)
      logoOk = true
    } catch (e) { logoOk = false } // image illisible → repli texte, jamais de PDF cassé
  }
  if (!logoOk) {
    sans(15, 'bold'); ink(CAB_INK)
    doc.text(clip(capsCab(emp.nom || ''), 100, 15), CAB.X0, CAB.HEAD_TOP + 6)
  }
  doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.35)
  doc.roundedRect(CAB.X0 + 12, CAB.HEAD_TOP + 11, 78, 18, 2.5, 2.5, 'S')
  mono(8); ink(CAB_INK)
  const etab = [
    capsCab(emp.nom || ''),
    capsCab(emp.adresse || ''),
    capsCab([emp.codePostal, emp.ville].filter(Boolean).join(' ')),
  ]
  etab.forEach((l, i) => doc.text(clip(l, 72, 8), CAB.X0 + 16, CAB.HEAD_TOP + 16.5 + i * 5))

  // Droite : titre + identifiants
  sans(15, 'bold'); ink(CAB_INK)
  doc.text('BULLETIN DE PAIE', 118, CAB.HEAD_TOP + 6)
  // Libellés à gauche, deux-points sur une colonne fixe, valeurs en mono.
  // « DU » et « AU » sont calés à DROITE, contre les deux-points, sous
  // « PERIODE D'EMPLOI » — disposition de l'original.
  const kvR = (label, value, y, alignRight = false) => {
    sans(6.2); ink(CAB_INK)
    if (alignRight) right(label, 158.5, y); else doc.text(label, 118, y)
    doc.text(':', 160, y)
    mono(8); doc.text(String(value == null ? '' : value), 163, y)
  }
  let hy = CAB.HEAD_TOP + 12.5
  kvR('MATRICULE', sal.matricule || '', hy); hy += 4.2
  kvR('PERIODE D\'EMPLOI', `${mm2}/${year}`, hy); hy += 4.2
  kvR('DU', dateLongue(periodStart), hy, true); hy += 4.2
  kvR('AU', dateLongue(periodEnd), hy, true); hy += 4.2
  kvR('DATE DE PAIEMENT', dateLongue(datePaie), hy); hy += 4.2
  kvR('NO DE SECURITE SOCIALE', String(sal.numSecu || '').replace(/\s/g, ''), hy)

  // ═══ 2ᵉ RANG : SIRET / APE / CCN — identité du salarié ══════════════════════
  let y = CAB.ROW2_Y
  sans(6.2); ink(CAB_INK)
  doc.text('N° SIRET:', CAB.X0, y)
  mono(8); doc.text(String(emp.siret || '').replace(/\s/g, ''), CAB.X0 + 24, y)
  sans(6.2); doc.text('N° APE:', CAB.X0 + 62, y)
  mono(8); doc.text(String(emp.codeAPE || ''), CAB.X0 + 76, y)
  sans(6.2); doc.text('CONVENTION', CAB.X0, y + 6); doc.text('COLLECTIVE:', CAB.X0, y + 9.5)
  const ccn = capsCab(conventionMention(emp))
  mono(8)
  doc.splitTextToSize(ccn, 70).slice(0, 3).forEach((l, i) => doc.text(l, CAB.X0 + 24, y + 6 + i * 3.6))

  mono(9, 'bold')
  doc.text(clip(capsCab([sal.nom, sal.prenom].filter(Boolean).join(' ')), 80, 9), 118, y + 7)
  mono(8, 'bold')
  doc.text(clip(capsCab(sal.adresse || ''), 80, 8), 118, y + 13)
  doc.text(clip(capsCab([sal.codePostal, sal.ville].filter(Boolean).join(' ')), 80, 8), 118, y + 17)

  // ═══ ENCADRÉ EMPLOI (3 colonnes) ════════════════════════════════════════════
  const ey = CAB.EMPLOI_TOP
  stroke(CAB.X0, ey, CAB.X1 - CAB.X0, CAB.EMPLOI_H, 0.3)
  rule(78, ey, 78, ey + CAB.EMPLOI_H); rule(140, ey, 140, ey + CAB.EMPLOI_H)
  const kvE = (label, value, x, yy, colon) => {
    mono(6.6); ink(CAB_INK)
    doc.text(label, x, yy); doc.text(':' + String(value == null ? '' : value), colon, yy)
  }
  // Niveau et coefficient d'abord (mention R.3243-1 4°) : le statut en tête
  // faisait couper le coefficient (« … COEF. . »).
  const classif = [
    sal.niveau ? `NIV. ${sal.niveau}` : '',
    sal.coefficient ? `COEF. ${sal.coefficient}` : '',
    sal.echelon ? `ECH. ${sal.echelon}` : '',
    sal.statut ? capsCab(sal.statut) : '',
  ].filter(Boolean).join(' ')
  kvE('AFFECTATION', clip(capsCab(emp.nom || ''), 44, 6.6), CAB.X0 + 2, ey + 4, CAB.X0 + 30)
  kvE('EMPLOI', clip(capsCab(sal.emploi || ''), 44, 6.6), CAB.X0 + 2, ey + 7.5, CAB.X0 + 30)
  kvE('CLASSIFICATION', clip(classif, 44, 6.6), CAB.X0 + 2, ey + 12, CAB.X0 + 30)
  kvE('DATE ENTREE', dateFRcab(sal.dateEntree), 80, ey + 4, 112)
  kvE('DATE ANCIENNETE', dateFRcab(sal.dateEntree), 80, ey + 7.5, 112)
  const hm = parseFloat(data.horaireContractuel ?? data.horaireMensuel) || 0
  mono(6.6); doc.text(hm >= 151.67 ? 'TEMPS PLEIN' : 'TEMPS PARTIEL', 142, ey + 4)
  doc.text('TAUX HORAIRE :', 142, ey + 7.5)
  right(formatMontant(data.tauxHoraire), CAB.X1 - 3, ey + 7.5)

  // ═══ GRILLE PRINCIPALE — lignes ═════════════════════════════════════════════
  // kind : 'item' (ligne chiffrée) | 'cat' (rubrique en gras) | 'total' (à points
  // de conduite) | 'note' (libellé seul, sans montant) | 'gap'
  const rows = []
  const item = (o) => rows.push({ kind: 'item', ...o })

  item({ label: 'SALAIRE DE BASE', base: data.horaireMensuel, salAmt: data.salaireBase })
  // Absences : le salaire de base du moteur est DÉJÀ calculé sur les heures
  // payées — ligne indicative en heures, sans montant (avant le 11/10/2026 elle
  // portait −heures × taux : absence déduite deux fois à l'affichage).
  ;(data.absencesLignes || []).forEach((a) => {
    if ((a.heures || 0) > 0) {
      item({ label: `ABS. ${capsCab(a.label || 'ABSENCE')}`, base: a.heures })
    }
  })
  if (data.heuresSuppLignes && data.heuresSuppLignes.length > 0) {
    data.heuresSuppLignes.forEach((l) => {
      if ((l.heures || 0) > 0) item({ label: capsCab(l.label || `HEURES SUPP. ${l.tauxMult}%`), base: l.heures, taux: l.computedTauxHS, salAmt: l.brut })
    })
  } else if (data.heuresSupp > 0) {
    item({ label: 'HEURES SUPPLEMENTAIRES', base: data.heuresSupp, taux: data.tauxHS, salAmt: data.hsBrut })
  }
  if (data.primes && data.primes.length > 0) {
    data.primes.forEach((p) => { if ((p.montant || 0) > 0) item({ label: capsCab(p.label || 'PRIME'), salAmt: p.montant }) })
  } else if (data.primeExceptionnelle > 0) {
    item({ label: 'PRIME EXCEPTIONNELLE', salAmt: data.primeExceptionnelle })
  }
  const cpCab = lignesCongesPayes(data)
  if (cpCab) {
    item({ label: capsCab(cpCab.absenceCourt), base: cpCab.jours, salAmt: -cpCab.retenue })
    item({ label: capsCab(cpCab.indemnite), base: cpCab.jours, salAmt: cpCab.montant })
  }
  rows.push({ kind: 'total', label: '*REMUNERATION BRUTE.(1)', col: 'sal', value: data.totalBrut })

  // Cotisations, regroupées par rubrique. Une rubrique à ligne unique est
  // portée par sa propre ligne (comme FAMILLE / ASSURANCE CHOMAGE sur
  // l'original) ; à plusieurs lignes, en-tête gras puis lignes en retrait.
  const groups = []
  fusionCsgPsc(data.cotisations).forEach((c) => {
    const last = groups[groups.length - 1]
    if (last && last.category === c.category) last.items.push(c)
    else groups.push({ category: c.category, items: [c] })
  })
  groups.forEach((g) => {
    // Ligne unique fusionnée avec sa rubrique SEULEMENT si le nom de la ligne
    // n'apporte rien de plus (ex. « Famille » / « Allocations familiales »).
    // Sinon — prévoyance cadre rangée sous « Santé » en fin de liste — on garde
    // en-tête + ligne : fusionner ferait disparaître le nom de la cotisation.
    const fusionnable = (c, cat) => {
      const a = capsCab(c.name).replace(/[^A-Z]/g, ''), b = capsCab(cat).replace(/[^A-Z]/g, '')
      return a === b || b.includes(a) || (a.includes(b) && a.length - b.length <= 12)
    }
    if (g.items.length === 1 && fusionnable(g.items[0], g.category)) {
      const c = g.items[0]
      item({ label: capsCab(g.category), cap: true, base: c.base, taux: tauxSalAffiche(c), salAmt: c.partSal > 0 ? -c.partSal : 0, patAmt: c.partPat > 0 ? c.partPat : 0 })
    } else {
      rows.push({ kind: 'cat', label: capsCab(g.category) })
      g.items.forEach((c) => item({ label: capsCab(libelleOfficiel(c.name)), sub: true, base: c.base, taux: tauxSalAffiche(c), salAmt: c.partSal > 0 ? -c.partSal : 0, patAmt: c.partPat > 0 ? c.partPat : 0 }))
    }
  })
  const exoCab = exonerationsReparties(data)
  if (exoCab.sal || exoCab.pat) {
    item({ label: 'EXONERATIONS ET ALLEGEMENTS DE COTISATIONS', cap: true, salAmt: exoCab.sal, patAmt: -exoCab.pat })
  }
  rows.push({ kind: 'total', label: '*COTISAT.SALARIALES.(2)', col: 'sal', value: -(data.totalCotisSal || 0) })
  rows.push({ kind: 'total', label: '*COTISAT.PATRONALES', col: 'pat', value: data.totalCotisPat })
  item({ label: 'IMPOT SUR LE REVENU PRELEVE', cap: true, base: data.baseIR, taux: data.tauxIR, salAmt: -(data.irPreleve || 0) })
  rows.push({ kind: 'note', label: data.irAuto ? 'TAUX NON PERSONNALISE' : 'TAUX PERSONNALISE' })
  rows.push({ kind: 'total', label: '*AUTRES RETENUES....(4)', col: 'sal', value: -(data.irPreleve || 0) })

  // Tenue sur une page : l'interligne (et le corps avec lui) se resserre si le
  // bulletin est long, jamais sous le plancher de lisibilité.
  const AVAIL = CAB.BODY_BOTTOM - (CAB.BODY_TOP + CAB.BODY_HEAD_H + 3)
  const lineH = rows.length > 0 ? Math.min(CAB.LINE_H, AVAIL / rows.length) : CAB.LINE_H
  const bodySize = Math.max(4.8, Math.min(6.6, (lineH / CAB.LINE_H) * 6.6))

  // ── Cadre + en-tête à deux rangs ──
  const gy = CAB.BODY_TOP
  stroke(CAB.X0, gy, CAB.G_X1 - CAB.X0, CAB.BODY_BOTTOM - gy, 0.3)
  rule(CAB.X0, gy + CAB.BODY_HEAD_H, CAB.G_X1, gy + CAB.BODY_HEAD_H)
  ;[CAB.C_LBL_END, CAB.C_BASE, CAB.C_TAUX, CAB.C_SAL].forEach((x) => rule(x, gy, x, CAB.BODY_BOTTOM))
  rule(CAB.C_BASE, gy + 4.5, CAB.C_SAL, gy + 4.5) // sous « PART EMPLOYE »
  sans(5.4); ink(CAB_INK)
  center('DESIGNATION', (CAB.X0 + CAB.C_LBL_END) / 2, gy + 6)
  center('NOMBRE', (CAB.C_LBL_END + CAB.C_BASE) / 2, gy + 3.4)
  center('OU BASE', (CAB.C_LBL_END + CAB.C_BASE) / 2, gy + 7.6)
  center('PART EMPLOYE', (CAB.C_BASE + CAB.C_SAL) / 2, gy + 3.4)
  center('TAUX OU %', (CAB.C_BASE + CAB.C_TAUX) / 2, gy + 7.6)
  center('MONTANT', (CAB.C_TAUX + CAB.C_SAL) / 2, gy + 7.6)
  center('EMPLOYEUR', (CAB.C_SAL + CAB.C_PAT) / 2, gy + 3.4)
  center('MONTANT', (CAB.C_SAL + CAB.C_PAT) / 2, gy + 7.6)

  // Filets des décimales — le « pré-imprimé » — sur la hauteur du corps
  const bodyY0 = gy + CAB.BODY_HEAD_H
  ;[CAB.C_BASE, CAB.C_TAUX, CAB.C_SAL, CAB.C_PAT].forEach((xr) => decRule(xr, bodyY0, CAB.BODY_BOTTOM, bodySize))

  // ── Corps ──
  let yy = bodyY0 + lineH + 0.6
  const lblMax = CAB.C_LBL_END - CAB.LABEL_X - 1
  rows.forEach((r) => {
    ink(CAB_INK)
    if (r.kind === 'gap') { yy += lineH; return }
    if (r.kind === 'cat') {
      mono(bodySize, 'bold'); doc.text(clip(r.label, lblMax, bodySize), CAB.LABEL_X, yy); yy += lineH; return
    }
    if (r.kind === 'note') {
      mono(bodySize); doc.text(clip(r.label, lblMax, bodySize), CAB.LABEL_X, yy); yy += lineH; return
    }
    if (r.kind === 'total') {
      mono(bodySize, 'bold')
      const xr = r.col === 'pat' ? CAB.C_PAT : CAB.C_SAL
      const intX = cell(r.value, xr, yy, bodySize, { keepZero: true })
      // Points de conduite du libellé jusqu'au nombre — traversant les colonnes
      // intermédiaires, comme sur l'original.
      const label = r.label
      doc.text(label, CAB.LABEL_X, yy)
      const from = CAB.LABEL_X + doc.getTextWidth(label)
      const to = (intX ?? xr) - chW(bodySize) * 0.6
      const n = Math.max(0, Math.floor((to - from) / chW(bodySize)))
      if (n > 0) doc.text('.'.repeat(n), from, yy)
      yy += lineH; return
    }
    mono(bodySize, r.cap ? 'bold' : 'normal')
    const x = r.sub ? CAB.SUB_X : CAB.LABEL_X
    doc.text(clip(r.label, CAB.C_LBL_END - x - 1, bodySize), x, yy)
    mono(bodySize)
    cell(r.base, CAB.C_BASE, yy, bodySize)
    // Taux à 3 décimales quand il en a (APEC 0,024 % était imprimé « 0,02 »).
    cell(r.taux, CAB.C_TAUX, yy, bodySize, { dec: [2, 3, 4].find((d) => Math.abs(r.taux * 10 ** d - Math.round(r.taux * 10 ** d)) < 1e-6) || 3 })
    cell(r.salAmt, CAB.C_SAL, yy, bodySize)
    cell(r.patAmt, CAB.C_PAT, yy, bodySize)
    yy += lineH
  })

  // ═══ CALENDRIER JOURNALIER ═══════════════════════════════════════════════════
  const kx0 = CAB.K_X0, kx1 = CAB.K_X1, kw = kx1 - kx0
  // Une seule boîte, du haut de la grille au bas des congés ; la légende des
  // codes d'incident vit DANS cette boîte, sous un filet — comme l'original.
  stroke(kx0, gy, kw, CAB.CP_TOP + CAB.CP_H - gy, 0.3)
  sans(4.6, 'bold'); ink(CAB_INK)
  center('INFORMATIONS JOURNALIERES', kx0 + kw / 2, gy + 3)
  sans(4.6)
  center(`DU ${dateTiret(periodStart)}  AU ${dateTiret(periodEnd)}`, kx0 + kw / 2, gy + 6.4)
  rule(kx0, gy + 7.6, kx1, gy + 7.6)
  const kJour = kx0 + 9, kTrav = CAB.K_TRAV
  sans(4.2)
  center('JOUR', kx0 + 5.5, gy + 10.4)
  center('TRAVAIL', (kJour + 3 + kTrav) / 2, gy + 10.4)
  center('INCIDENT', (kTrav + kx1) / 2, gy + 10.4)
  rule(kx0, gy + 11.6, kx1, gy + 11.6)
  rule(kJour + 2, gy + 7.6, kJour + 2, gy + 11.6); rule(kTrav + 0.5, gy + 7.6, kTrav + 0.5, gy + 11.6)

  const cal = calendrierMois(year, month, hm, { presenceStart: data.proration?.presenceStart, presenceEnd: data.proration?.presenceEnd, congesDebut: data.congesPayes?.debut, congesFin: data.congesPayes?.fin, absences: data.absencesLignes })
  const kSize = 6
  const kLine = Math.min(3.0, (CAB.BODY_BOTTOM - (gy + 13)) / Math.max(28, cal.length))
  const kIncNum = kTrav + 9 // bord droit du nombre d'heures d'incident
  decRule(kTrav, gy + 12, gy + 12 + kLine * cal.length + 1, kSize)
  decRule(kIncNum, gy + 12, gy + 12 + kLine * cal.length + 1, kSize)
  cal.forEach((d, i) => {
    const ky = gy + 12 + kLine * (i + 1)
    mono(kSize); ink(CAB_INK)
    doc.text(`${d.lettre} ${String(d.jour).padStart(2, '0')}`, kx0 + 1.5, ky)
    if (d.incident) {
      // Jour férié chômé payé : les heures du jour passent en INCIDENT avec le
      // code, la colonne TRAVAIL reste vide — disposition de l'original.
      cell(d.heuresIncident, kIncNum, ky, kSize)
      doc.text(d.incident, kIncNum + 1.2, ky)
    } else if (d.heures > 0) {
      cell(d.heures, kTrav, ky, kSize)
    }
  })

  // ═══ NET SOCIAL / NET AVANT IMPÔT ═══════════════════════════════════════════
  const ny = CAB.NET_TOP
  stroke(CAB.X0, ny, CAB.G_X1 - CAB.X0, CAB.NET_H, 0.3)
  rule(CAB.C_SAL, ny, CAB.C_SAL, ny + CAB.NET_H)
  decRule(CAB.C_PAT, ny, ny + CAB.NET_H, 7.2)
  mono(7.2, 'bold'); ink(CAB_INK)
  doc.text('MONTANT NET SOCIAL', CAB.LABEL_X, ny + 5)
  cell(data.netSocial, CAB.C_PAT, ny + 5, 7.2, { keepZero: true })
  doc.text('NET A PAYER AVANT IMPOT SUR LE REVENU', CAB.LABEL_X, ny + 11.5)
  cell(data.netAvantIR, CAB.C_PAT, ny + 11.5, 7.2, { keepZero: true })

  // ═══ REVENUS EN EUROS (mois / cumul) + NET A PAYER ══════════════════════════
  const ry = CAB.REV_TOP
  const cum = data.cumuls || {}
  // Bloc gauche
  const rx0 = CAB.X0, rx1 = 92, rMois = 66, rCum = 91
  stroke(rx0, ry, rx1 - rx0, CAB.REV_H, 0.3)
  rule(46, ry, 46, ry + CAB.REV_H); rule(rMois + 1.5, ry, rMois + 1.5, ry + CAB.REV_H)
  rule(rx0, ry + 4.6, rx1, ry + 4.6)
  mono(6.2); ink(CAB_INK)
  doc.text('REVENUS EN EUROS', rx0 + 1.5, ry + 3.3)
  center('DU MOIS', (46 + rMois + 1.5) / 2, ry + 3.3)
  center(`DEPUIS 01 ${year}`, (rMois + 1.5 + rx1) / 2, ry + 3.3)
  decRule(rMois, ry + 4.6, ry + CAB.REV_H, 6.2); decRule(rCum, ry + 4.6, ry + CAB.REV_H, 6.2)
  const rLine = (label, m, c, yy2) => {
    mono(6.2); doc.text(label, rx0 + 1.5, yy2)
    cell(m, rMois, yy2, 6.2, { keepZero: true }); cell(c, rCum, yy2, 6.2, { keepZero: true })
  }
  rLine('PRELEVEMENT A LA SOURCE', data.irPreleve, cum.irPreleve, ry + 9)
  rLine('TOTAL VERSE EMPLOYEUR', data.totalVerseEmployeur, cum.totalVerse, ry + 13)
  rLine('NET FISCAL', data.baseIR, cum.netImposable, ry + 23)
  doc.setLineDashPattern([0.6, 0.6], 0); rule(rx0 + 1.5, ry + 26, 44, ry + 26, 0.2); doc.setLineDashPattern([], 0)
  // « HS/HC exonérées fiscal » : montant net exonéré d'impôt (art. 81 quater
  // CGI), du mois et cumulé. Vide sans heures sup. — comme le gabarit
  // d'origine. Les bulletins figés avant le 08/10/2026 n'ont pas ce champ
  // (le moteur n'exonérait rien) et restent donc vides, à juste titre.
  mono(6.2); doc.text('HS/HC EXONEREES FISCAL', rx0 + 1.5, ry + 31)
  if ((data.montantNetHSExonere || 0) > 0 || (cum.hsExonere || 0) > 0) {
    cell(data.montantNetHSExonere || 0, rMois, ry + 31, 6.2, { keepZero: true })
    cell(cum.hsExonere || 0, rCum, ry + 31, 6.2, { keepZero: true })
  }

  // Bloc NET A PAYER — double cadre comme sur l'original
  const nx0 = 94, nx1 = CAB.G_X1
  stroke(nx0, ry, nx1 - nx0, CAB.REV_H, 0.7)
  stroke(nx0 + 1, ry + 1, nx1 - nx0 - 2, CAB.REV_H - 2, 0.25)
  rule(nx0 + 1, ry + 12, nx1 - 1, ry + 12, 0.7)
  mono(7, 'bold'); ink(CAB_INK)
  doc.text('NET A PAYER', nx0 + 3, ry + 5.2)
  mono(5); doc.text('1-2-4', nx0 + 3, ry + 8)
  mono(7, 'bold'); doc.text('EN EUROS', nx0 + 3, ry + 11)
  decRule(nx1 - 3, ry + 1, ry + 12, 9.5)
  mono(9.5, 'bold'); cell(data.netAPayer, nx1 - 3, ry + 7, 9.5, { keepZero: true })
  const mode = capsCab(data.modePaiement || sal.modePaiement || 'VIREMENT')
  mono(7, 'bold'); doc.text(mode, nx0 + 26, ry + 11)
  mono(7, 'bold'); doc.text(clip(capsCab([sal.prenom, sal.nom].filter(Boolean).join(' ')), 56, 7), nx0 + 6, ry + 17)
  if (sal.iban) { mono(6.6, 'bold'); doc.text(`IBAN: ${sal.iban}`, nx0 + 3, ry + 22) }
  if (sal.bic) { mono(6.6, 'bold'); doc.text(`BIC : ${sal.bic}`, nx0 + 3, ry + 26) }

  // ═══ CONGÉS PAYÉS / COMMENTAIRES / LÉGENDE ══════════════════════════════════
  const cy = CAB.CP_TOP
  stroke(CAB.X0, cy, rx1 - CAB.X0, CAB.CP_H, 0.3)
  const lv = data.leave || {}
  const prisN1 = Math.min(lv.cpN1Acquis || 0, lv.cumulCongesPris || 0)
  const prisN = (lv.cumulCongesPris || 0) > (lv.cpN1Acquis || 0) ? (lv.cumulCongesPris || 0) - (lv.cpN1Acquis || 0) : 0
  mono(6.2); ink(CAB_INK)
  doc.text('CONGES PAYES---  ACQUIS       PRIS      SOLDE', CAB.X0 + 1.5, cy + 4)
  const cpRow = (label, a, p, s, yy3) => {
    doc.text(label, CAB.X0 + 1.5, yy3)
    right(formatMontant(a), CAB.X0 + 34, yy3); right(formatMontant(p), CAB.X0 + 50, yy3); right(formatMontant(s), CAB.X0 + 66, yy3)
  }
  cpRow('EN COURS', lv.cpNAcquis || 0, prisN, lv.cpNSolde || 0, cy + 8)
  cpRow('ACQUIS', lv.cpN1Acquis || 0, prisN1, lv.cpN1Solde || 0, cy + 12)
  doc.text('--- ----------------- --- ----------------', CAB.X0 + 1.5, cy + 16)

  stroke(nx0, cy, nx1 - nx0, CAB.CP_H, 0.3)
  rule(nx0 + 5, cy, nx0 + 5, cy + CAB.CP_H)
  sans(4.6); ink(CAB_INK)
  doc.text('COMMENTAIRES', nx0 + 3.6, cy + CAB.CP_H - 2, { angle: 90 })

  rule(kx0, cy, kx1, cy)
  mono(6.2); ink(CAB_INK)
  doc.text('JF J.FERIE CHOME PAYE', kx0 + 1.5, cy + 4.5)
  if (cal.some((d) => d.incident === 'CP')) doc.text('CP CONGES PAYES', kx0 + 1.5, cy + 7.5)
  if (cal.some((d) => d.incident === 'AB')) doc.text('AB ABSENCE NON REMUNEREE', kx0 + 1.5, cy + (cal.some((d) => d.incident === 'CP') ? 10.5 : 7.5))

  // ═══ PIED ═══════════════════════════════════════════════════════════════════
  sans(5.4); ink(CAB_INK)
  center('Nous vous recommandons de conserver votre bulletin de paie, sans limitation de durée - Pour davantage d\'informations, voir la rubrique dédiée au bulletin de paie sur www.service-public.fr.', 105, CAB.FOOT_Y)

  if (options.watermark) {
    const n = doc.getNumberOfPages()
    for (let p = 1; p <= n; p++) {
      doc.setPage(p)
      try { doc.setGState(new doc.GState({ opacity: 0.13 })) } catch { /* Deno : ignoré */ }
      doc.setTextColor(180, 40, 40); doc.setFont('helvetica', 'bold'); doc.setFontSize(30)
      for (let k = 0; k < 5; k++) doc.text('SPÉCIMEN — NON PAYÉ', 22, 60 + k * 52, { angle: 33 })
      try { doc.setGState(new doc.GState({ opacity: 1 })) } catch { /* Deno : ignoré */ }
    }
  }

  return doc
}


/** SIRET « XXX XXX XXX XXXXX » — copie locale (celle de buildPdfDoc lui est interne). */
function formatSiretTrad(siret) {
  const d = String(siret || '').replace(/\s/g, '')
  return d.length === 14 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : (siret || '')
}

/* ═══════════════════════════════════════════════════════════════════════════
   MODÈLE « ENCADRÉ » — cadres arrondis, rubriques en gras, cumuls et congés.

   Mise en page des bulletins « clarifiés » produits par les logiciels de paie
   des cabinets : titre en haut à gauche, cadre identité du salarié, cadres gris
   employeur et destinataire, tableau LIBELLE / BASE / TAUX / A PAYER /
   Taux Pat. / Mt Pat. avec bandeaux gris pour les totaux, blocs net avant
   impôt, impôt sur le revenu, net à payer, total versé employeur, cumuls
   période / année, congés et repos, mention légale de pied de page.

   Relevé le 09/10/2026 sur trois bulletins de référence (janvier à mars 2026) :
   géométrie lue DANS LE FLUX PDF (opérateurs re/m/l/c et Tm/Td/TJ) — positions
   au dixième de point, Helvetica / Helvetica-Bold / Helvetica-Oblique, traits
   0,4 / 0,5 / 0,9 pt, gris 242, rayons 2 et 3 pt, interligne de 10 pt.
   STRUCTURE uniquement : aucune valeur, aucun nom, aucun SIRET n'en est repris.

   Une seule description de la page sert aux deux rendus : `layoutEncadre`
   renvoie une liste de primitives (cadres, filets, textes) en points depuis le
   coin haut-gauche ; `buildEncadreDoc` la trace avec jsPDF, l'aperçu écran
   (BulletinPreviewEncadre.jsx) la trace en SVG. L'aperçu et le PDF payé ne
   peuvent donc pas diverger.

   Données absentes de Salareo (bases de congés payés, repos compensateur,
   remboursements de frais…) : cellules laissées VIDES plutôt que remplies avec
   une valeur plausible — la mise en page est reproduite, jamais les données.
   ═══════════════════════════════════════════════════════════════════════════ */

const ENC_GRIS = 242
/** Repli si le calcul ne fournit pas `plafondSS` (bulletins enregistrés avant le 09/10/2026). */
const ENC_PMSS = { 2024: 3864, 2025: 3925, 2026: 4005 }

/* Largeurs AFM Helvetica / Helvetica-Bold (1/1000 em), caractères 32 à 126 puis
   lettres accentuées : mesurer un texte SANS document jsPDF, pour que l'ajustement
   des libellés longs soit identique dans le PDF et dans l'aperçu SVG. */
const ENC_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]
const ENC_WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]
const ENC_ACC = { à: 'a', â: 'a', ä: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', î: 'i', ï: 'i', ô: 'o', ö: 'o', ù: 'u', û: 'u', ü: 'u', ÿ: 'y', ç: 'c', À: 'A', Â: 'A', É: 'E', È: 'E', Ê: 'E', Ë: 'E', Î: 'I', Ô: 'O', Ù: 'U', Û: 'U', Ç: 'C', '’': "'", '°': 'o', '«': '<', '»': '>' }

function encW(s, size, bold = false) {
  const t = bold ? ENC_WB : ENC_W
  let u = 0
  for (const ch of String(s || '')) {
    const c = ENC_ACC[ch] || ch
    const code = c.charCodeAt(0)
    u += code >= 32 && code <= 126 ? t[code - 32] : 556
  }
  return (u / 1000) * size
}
/** Taille réduite pour que `s` tienne dans `maxW` (jamais sous `min`). */
function encFit(s, size, maxW, bold = false, min = 5) {
  const w = encW(s, size, bold)
  return w <= maxW ? size : Math.max(min, (size * maxW) / w)
}
/** Tronque `s` (suivi d'un point) s'il déborde encore de `maxW` à la taille donnée. */
function encClip(s, size, maxW, bold = false) {
  let t = String(s || '')
  if (encW(t, size, bold) <= maxW) return t
  while (t.length > 1 && encW(`${t}.`, size, bold) > maxW) t = t.slice(0, -1)
  return `${t.trimEnd()}.`
}
/** Nombre FR « 5 434,13 » (espace normale, signe moins devant) ; '' si nul sauf `keepZero`. */
function encNum(v, dec = 2, keepZero = false) {
  const n = parseFloat(v)
  if (!Number.isFinite(n) || (!keepZero && Math.abs(n) < 0.0005)) return ''
  const [i, d] = Math.abs(n).toFixed(dec).split('.')
  return (n < 0 && Math.abs(n) >= 0.0005 ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (dec > 0 ? `,${d}` : '')
}
const encPct = (v) => { const s = encNum(v, 3); return s ? `${s} %` : '' }
/** Majuscules sans accents, comme les rubriques de l'original (« SANTE », « ASSURANCE CHOMAGE »). */
const encCaps = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

/** Libellés des rubriques : catégorie du moteur → intitulé du bulletin. */
const ENC_RUBRIQUES = {
  'Santé': 'SANTE',
  'Retraite': 'RETRAITE',
  'Famille - Sécurité sociale': 'FAMILLE',
  'Assurance chômage': 'ASSURANCE CHOMAGE',
  "Autres contributions dues par l'employeur": "AUTRES CONTRIBUTIONS DUES PAR L'EMPLOYEUR",
}
/** Ordre des rubriques sur l'original ; les catégories inconnues se placent avant « AUTRES ». */
/** Abscisse de départ des libellés de bandeau sur l'original (alignés à droite sur 317 pt). */
const ENC_BANDES = { 'Total brut': 284.7, 'Total des cotisations et contributions': 192.5, 'MONTANT NET SOCIAL': 237.7 }
const ENC_ORDRE = ['Santé', '__AT__', 'Retraite', 'Famille - Sécurité sociale', 'Assurance chômage', '__AUTRES_INCONNUES__', "Autres contributions dues par l'employeur", 'CSG/CRDS']

/**
 * Description complète de la page (points, origine en haut à gauche, A4 595 × 842).
 * @returns {{ w: number, h: number, ops: Array<object> }}
 *   ops : { k:'rr', x,y,w,h,r, fill (gris|null), lw }  cadre arrondi
 *         { k:'ln', x1,y1,x2,y2, lw }                   filet
 *         { k:'lb', x,y0,y1,x1, r, lw }                 trait épais gauche + bas (relief des tableaux)
 *         { k:'tx', s, x, y, size, st:'n'|'b'|'i', al:'l'|'r'|'c' }  texte (y = ligne de base)
 */
export function layoutEncadre(data, employerInfo, employeeInfo, month, year) {
  const d = data || {}
  const emp = employerInfo || {}
  const sal = employeeInfo || {}
  const ops = []
  const rr = (x, y, w, h, r, fill, lw = 0) => ops.push({ k: 'rr', x, y, w, h, r, fill: fill ? ENC_GRIS : null, lw })
  const ln = (x1, y1, x2, y2, lw = 0.5) => ops.push({ k: 'ln', x1, y1, x2, y2, lw })
  const lb = (x, y0, y1, x1) => ops.push({ k: 'lb', x, y0, y1, x1, r: 3, lw: 0.9 })
  const texts = []
  const tx = (s, x, y, size, st = 'n', al = 'l') => {
    const t = s == null ? '' : String(s)
    if (t.trim()) texts.push({ k: 'tx', s: t, x, y, size, st, al })
  }

  // ── Période ───────────────────────────────────────────────────────────────
  const mm = String(month + 1).padStart(2, '0')
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const periodStart = d.proration?.periodeDebut || `01/${mm}/${year}`
  const periodEnd = d.proration?.periodeFin || `${daysInMonth}/${mm}/${year}`
  const datePaie = datePaiementDe(d, month, year, periodEnd)
  const joursPeriode = d.proration?.partial ? (d.proration.joursPresents || 0) : daysInMonth

  const pmss = parseFloat(d.plafondSS) || ENC_PMSS[year] || 4005
  const hs = parseFloat(d.heuresSupp) || 0
  const heuresPayees = (parseFloat(d.horaireMensuel) || 0) + hs
  const heuresTheo = (parseFloat(d.horaireContractuel ?? d.horaireMensuel) || 0) + hs

  // ── Lignes du tableau ─────────────────────────────────────────────────────
  // kind : 'line' (élément, retrait) | 'head' (rubrique en gras, valeurs éventuelles)
  //        | 'band' (total sur bandeau gris) | 'blank'
  const rows = []
  const line = (o) => rows.push({ kind: 'line', ...o })

  line({ label: 'Salaire de base', base: d.horaireMensuel, taux: d.tauxHoraire, tauxEur: true, amt: d.salaireBase })
  // Absences : le moteur calcule le salaire de base sur les heures RÉELLEMENT
  // payées (absences déjà déduites) — ligne indicative en heures, sans montant,
  // pour ne pas déduire deux fois.
  ;(d.absencesLignes || []).forEach((a) => {
    if ((parseFloat(a.heures) || 0) > 0) line({ label: `Absence ${a.label || ''}`.trim(), base: -a.heures })
  })
  if (d.heuresSuppLignes && d.heuresSuppLignes.length > 0) {
    d.heuresSuppLignes.forEach((l) => {
      if ((l.heures || 0) > 0) line({ label: l.label || `Heures supplémentaires ${l.tauxMult}%`, base: l.heures, taux: l.computedTauxHS, tauxEur: true, amt: l.brut })
    })
  } else if (hs > 0) {
    line({ label: 'Heures supplémentaires', base: hs, taux: d.tauxHS, tauxEur: true, amt: d.hsBrut })
  }
  if (d.primes && d.primes.length > 0) {
    d.primes.forEach((p) => { if ((p.montant || 0) > 0) line({ label: p.label || 'Prime', amt: p.montant }) })
  } else if (d.primeExceptionnelle > 0) {
    line({ label: 'Prime exceptionnelle', amt: d.primeExceptionnelle })
  }
  const cpEnc = lignesCongesPayes(d)
  if (cpEnc) {
    line({ label: cpEnc.absence, base: cpEnc.jours, amt: -cpEnc.retenue })
    line({ label: cpEnc.indemnite, base: cpEnc.jours, amt: cpEnc.montant })
  }
  rows.push({ kind: 'band', label: 'Total brut', amt: d.totalBrut })

  // Rubriques de cotisations, dans l'ordre de l'original.
  const groupes = new Map()
  fusionCsgPsc(d.cotisations).forEach((c) => {
    let cat = c.category || ''
    if (/^accident/i.test(c.name || '')) cat = '__AT__'
    if (!groupes.has(cat)) groupes.set(cat, [])
    groupes.get(cat).push(c)
  })
  const connues = new Set(ENC_ORDRE)
  const ordre = []
  ENC_ORDRE.forEach((cat) => {
    if (cat === '__AUTRES_INCONNUES__') { for (const k of groupes.keys()) if (!connues.has(k)) ordre.push(k) } else if (groupes.has(cat)) ordre.push(cat)
  })
  const valeurs = (c) => ({
    base: c.base, taux: tauxSalAffiche(c), amt: c.partSal > 0 ? -c.partSal : 0,
    tpat: c.tauxPat, mpat: c.partPat > 0 ? -c.partPat : 0,
  })
  ordre.forEach((cat) => {
    const items = groupes.get(cat)
    if (cat === '__AT__') {
      items.forEach((c) => rows.push({ kind: 'head', label: 'ACCIDENT DU TRAVAIL-MALADIES PROFESSIONNELLES', ...valeurs(c) }))
    } else if (cat === 'CSG/CRDS') {
      // Intitulés réglementaires du bulletin clarifié (arrêté du 25/02/2016).
      items.forEach((c) => {
        const nom = c.name || ''
        const label = /non imposable/i.test(nom) ? "CSG déductible de l'impôt sur le revenu"
          : /imposable/i.test(nom) ? "CSG/CRDS non déductible de l'impôt sur le revenu" : nom
        rows.push({ kind: 'head', label, ...valeurs(c) })
      })
    } else if (cat === "Autres contributions dues par l'employeur") {
      // Ligne unique, part patronale agrégée — comme l'original.
      const total = items.reduce((s, c) => s + (parseFloat(c.partPat) || 0), 0)
      rows.push({ kind: 'head', label: ENC_RUBRIQUES[cat], mpat: total > 0 ? -total : 0 })
    } else if (items.length === 1 && cat === 'Famille - Sécurité sociale') {
      rows.push({ kind: 'head', label: ENC_RUBRIQUES[cat], ...valeurs(items[0]) })
    } else {
      rows.push({ kind: 'head', label: ENC_RUBRIQUES[cat] || encCaps(cat) })
      items.forEach((c) => line({ label: c.name, ...valeurs(c) }))
    }
  })

  if ((d.exoCotisSalHS || 0) > 0) {
    rows.push({ kind: 'head', label: 'EXONERATION DE COTISATIONS SALARIALES (HEURES SUP.)', taux: d.tauxExoSal, amt: d.exoCotisSalHS })
  }
  const exoPat = (parseFloat(d.allegementPatHS) || 0) + (parseFloat(d.reductionGenerale) || 0)
  if (exoPat > 0) rows.push({ kind: 'head', label: 'EXONERATIONS DE COTISATIONS EMPLOYEUR', mpat: exoPat })

  rows.push({ kind: 'blank' })
  line({ label: 'Net imposable', amt: d.baseIR })
  rows.push({ kind: 'band', label: 'Total des cotisations et contributions', amt: -(d.totalCotisSal || 0), mpat: -(d.totalCotisPat || 0) })
  rows.push({ kind: 'band', label: 'MONTANT NET SOCIAL', amt: d.netSocial })

  // Une page garantie : au-delà de 38 lignes, l'interligne (10 pt) et le corps
  // se resserrent ensemble, jamais sous 5 pt.
  const FIRST = 252.6
  const LAST = 626
  const pitch = rows.length > 1 ? Math.min(10, (LAST - FIRST) / (rows.length - 1)) : 10
  const sc = pitch / 10
  const fs = Math.max(5, 7 * sc)
  const fsHead = Math.max(5, 7.2 * sc)

  // ── Cadres (ordre du flux d'origine : les bandeaux de totaux passent SOUS les filets) ──
  rr(245, 63, 325, 85, 2, true, 0.5)          // employeur
  rr(245, 152, 325, 73, 2, true, 0.5)         // destinataire
  rr(20, 91, 220, 133, 2, false, 0.5)         // identité du salarié
  rr(20, 637, 550, 11, 2, true, 0.5)          // net avant impôt
  rr(20, 653, 550, 11, 2, true, 0.5)          // bandeau impôt sur le revenu
  ;[312, 376, 440, 505].forEach((x) => ln(x, 653, x, 683))
  rr(20, 653, 550, 30, 3, false, 0.4); lb(20, 655, 683, 568)
  rr(20, 688, 550, 11, 3, true, 0.4)          // net à payer
  rr(20, 714, 550, 11, 3, true, 0.4)          // total versé employeur
  rr(20, 730, 550, 11, 3, true, 0.4)          // bandeau des cumuls
  ;[60, 124, 186, 249, 312, 376, 440, 505].forEach((x) => ln(x, 730, x, 760))
  rr(20, 730, 550, 30, 3, false, 0.4); lb(20, 732, 760, 568)
  rr(20, 765, 550, 31, 3, true, 0.4)          // congés et repos
  rows.forEach((r, i) => { if (r.kind === 'band') rr(20, FIRST + i * pitch - 7.5 * sc, 550, 10.5 * sc, 3, true, 0) })
  rr(20, 234, 550, 12, 3, true, 0)            // bandeau des colonnes
  ;[320, 370, 430, 485].forEach((x) => ln(x, 234, x, 245))
  rr(20, 234, 550, 11, 3, false, 0.4); lb(20, 236, 245, 568)
  ;[320, 370, 430, 485].forEach((x) => ln(x, 245, x, 632))
  rr(20, 245, 550, 387, 3, false, 0.4); lb(20, 247, 632, 568)

  // ── En-tête ───────────────────────────────────────────────────────────────
  tx('BULLETIN DE PAIE', 23, 54, 16, 'b')
  tx('Paye du :', 23, 76, 9); tx(periodStart, 93, 76, 9); tx('au :', 146.1, 76, 9); tx(periodEnd, 173, 76, 9)

  const raison = emp.raisonSociale || emp.nom || ''
  tx(encClip(raison, encFit(raison, 11, 312, true, 7), 312, true), 253, 76, encFit(raison, 11, 312, true, 7), 'b')
  if (emp.libelleAPE) {
    const s = encFit(emp.libelleAPE, 6.6, 312, false, 4.8)
    tx(encClip(emp.libelleAPE, s, 312), 253, 104, s)
  }
  tx(encClip(emp.adresse, 9, 312), 253, 113.6, 9)
  tx(emp.codePostal, 253, 125.6, 9); tx(encClip(emp.ville, 9, 272), 293, 125.6, 9)
  tx('NAF', 253, 141, 9); tx(emp.codeAPE, 293, 137.6, 9)
  tx('SIRET', 373, 141, 9); tx(String(emp.siret || '').replace(/\s/g, ''), 403, 137.6, 9)

  ;[['Matricule', 105], ['N° S.S.', 117], ['Emploi', 129], ['Qualification', 141], ['Coefficient', 153],
    ['Entrée le', 177], ['Heures payées', 203], ['Plafond période', 215]].forEach(([l, y]) => tx(l, 23, y, 9))
  tx(encClip(sal.matricule, 9, 155), 83, 104, 9)
  tx(encClip(sal.numSecu, 9, 155), 83, 117, 9)
  tx(encClip(sal.emploi, 9, 155), 83, 125.6, 9)
  tx(encClip(sal.statut, 9, 155), 83, 137.6, 9)
  tx(encClip([sal.niveau, sal.coefficient, sal.echelon].filter(Boolean).join('  '), 9, 155), 83, 149.6, 9)
  tx(formatDateFR(sal.dateEntree), 83, 174.6, 9)
  tx(encNum(heuresPayees, 3, true), 93, 200.6, 9)
  tx(`T : ${encNum(heuresTheo, 3, true)}`, 173, 200.6, 9)
  tx(encNum(pmss, 2, true), 93, 213.6, 9)
  // Jours de présence, seulement pour un mois INCOMPLET (entrée / sortie en cours
  // de mois). L'original affichait « 28 /31 » pour tout mois de moins de 31 jours,
  // mention qui fait croire à une proratisation d'un mois complet : retirée.
  if (d.proration?.partial && joursPeriode > 0) tx(`${joursPeriode} /${daysInMonth}`, 173, 213.6, 9)

  const civ = sal.sexe === 'F' ? 'Mme' : sal.sexe === 'M' ? 'M.' : ''
  const nomComplet = [civ, String(sal.nom || '').toUpperCase(), sal.prenom].filter(Boolean).join(' ')
  const sNom = encFit(nomComplet, 10, 270, true, 7)
  tx(encClip(nomComplet, sNom, 270, true), 293, 161.6, sNom, 'b')
  tx(encClip(sal.adresse, 10, 270), 293, 187.6, 10)
  tx(encClip([sal.codePostal, sal.ville].filter(Boolean).join('  '), 10, 270), 293, 200.6, 10)

  // Convention collective — ou, à défaut, la référence au Code du travail (art. R.3243-1, 3°).
  const ccn = `Convention collective : ${conventionMention(emp)}`
  tx(encClip(ccn, 7, 540), 26.9, 231, 7)

  // ── Tableau ───────────────────────────────────────────────────────────────
  tx('LIBELLE', 31.9, 242, 8, 'b'); tx('BASE', 331.4, 242, 8, 'b'); tx('TAUX', 391.9, 242, 8, 'b')
  tx('A PAYER', 442, 242, 8, 'b'); tx('Taux Pat.', 489.6, 242, 8, 'b'); tx('Mt Pat.', 540.8, 242, 8, 'b')

  // Bords droits des colonnes numériques (l'original termine les montants par une espace).
  const cells = (r, y, st) => {
    tx(encNum(r.base, 2), 367, y, fs, st, 'r')
    // Taux en € à 3 décimales comme l'original, 4 quand il en a 4 (taux déduit
    // d'un salaire mensuel : 2 000 € / 151,67 h = 13,1865).
    const decEur = Math.abs(r.taux * 1000 - Math.round(r.taux * 1000)) > 1e-6 ? 4 : 3
    tx(r.tauxEur ? encNum(r.taux, decEur) : encPct(r.taux), 427, y, fs, st, 'r')
    tx(encNum(r.amt), 480.05, y, fs, st, 'r')
    tx(encPct(r.tpat), 517, y, fs, st, 'r')
    tx(encNum(r.mpat), 565.05, y, fs, st, 'r')
  }
  rows.forEach((r, i) => {
    const y = FIRST + i * pitch
    if (r.kind === 'blank') return
    if (r.kind === 'band') {
      // Libellés fixes posés à leur abscisse d'origine (bord droit à 317 pt) ; repli aligné à droite.
      const x0 = ENC_BANDES[r.label]
      if (x0 != null && sc === 1) tx(r.label, x0, y, fs, 'b'); else tx(r.label, 317, y, fs, 'b', 'r')
      cells(r, y, 'b')
      return
    }
    const head = r.kind === 'head'
    const x = head ? 23 : 27.84
    const size = head ? fsHead : fs
    tx(encClip(r.label, size, 317 - x, head), x, y, size, head ? 'b' : 'n')
    cells(r, y, 'n')
  })

  // ── Pied : impôt, net, cumuls, congés ─────────────────────────────────────
  tx('MONTANT NET A PAYER AVANT IMPOT SUR LE REVENU', 23, 644, 7, 'b')
  tx(encNum(d.netAvantIR, 2, true), 565.05, 644, 7, 'b', 'r')

  tx('IMPOT SUR LE REVENU', 23, 660, 7, 'b'); tx('Base', 336.8, 660, 7, 'b')
  tx(d.irAuto === false ? 'Tx personnalisé' : 'Tx non pers.', 389.5, 660, 7, 'b')
  tx('Montant', 459.2, 660, 7, 'b'); tx('Montant annuel', 511.4, 660, 7, 'b')
  tx('Impôt sur le revenu prélevé à la source', 23, 670, 7, 'i')
  tx(encNum(d.baseIR, 2, true), 371.05, 670, 7, 'i', 'r')
  tx(encNum(d.tauxIR, 3, true), 435.05, 670, 7, 'i', 'r')
  tx(encNum(d.irPreleve, 2, true), 500.05, 670, 7, 'i', 'r')
  tx('Régularisation sur le revenu', 23, 680, 7, 'i')

  tx('MONTANT NET A PAYER (en Euros)', 23, 695, 7, 'b')
  tx(encNum(d.netAPayer, 2, true), 567, 695, 7, 'b', 'r')
  const mode = String(d.modePaiement || emp.modePaiement || 'VIREMENT').toUpperCase()
  tx(`Paiement le ${datePaie} par ${mode}${mode === 'VIREMENT' ? ' sur  RIB' : ''}`, 23, 709, 7)
  tx('TOTAL VERSE EMPLOYEUR', 23, 721, 7, 'b')
  tx(encNum(d.totalVerseEmployeur, 2, true), 567, 721, 7, 'b', 'r')

  ;[['Cumuls', 23], ['Brut', 84.8], ['Plafond S.S.', 135.6], ['Base T.A.', 203.1], ['Charges Pat.', 259.6],
    ['H. Payées', 326.5], ['H. Sup/Comp Exo', 379.6], ['Mt Sup/Comp Exo', 442.1], ['NET IMPOSABLE', 508.2]]
    .forEach(([l, x]) => tx(l, x, 737, 7, 'b'))
  tx('Période', 23, 747.5, 7, 'b'); tx('Année', 23, 757.5, 7, 'b')
  const cum = d.cumuls || {}
  const mois = parseFloat(cum.mois) || month + 1
  const plafondCumul = cum.plafond ?? pmss * mois
  const hsExoMois = parseFloat(d.montantNetHSExonere) || 0
  const colR = [119.05, 181.05, 244.05, 307.05, 371.05, 435.05, 500.05, 565.05]
  const periode = [encNum(d.totalBrut, 2, true), encNum(pmss, 2, true), encNum(Number.isFinite(d.currentMonthData?.baseTA) ? d.currentMonthData.baseTA : Math.min(parseFloat(d.totalBrut) || 0, pmss), 2, true),
    encNum(d.totalCotisPat, 2, true), encNum(heuresPayees, 3, true), hsExoMois > 0 ? encNum(hs, 3) : '', encNum(hsExoMois), encNum(d.baseIR, 2, true)]
  const annee = [encNum(cum.brut, 2, true), encNum(plafondCumul, 2, true), encNum(cum.baseTA ?? Math.min(parseFloat(cum.brut) || 0, plafondCumul), 2, true),
    encNum(cum.cotisPat, 2, true), encNum(cum.heures, 3, true), '', encNum(cum.hsExonere), encNum(cum.netImposable, 2, true)]
  periode.forEach((v, i) => tx(v, colR[i], 747.5, 7, 'n', 'r'))
  annee.forEach((v, i) => tx(v, colR[i], 757.5, 7, 'n', 'r'))

  ;[['CONGES', 23, 'l'], ['Dûs', 97, 'r'], ['Acquis', 147, 'r'], ['Pris', 197, 'r'], ['Restant', 247, 'r'], ['Bases', 297, 'r'],
    ['REPOS', 343, 'l'], ['Dûs', 417, 'r'], ['Acquis', 467, 'r'], ['Pris/Payés', 517, 'r'], ['Restant', 567, 'r']]
    .forEach(([l, x, al]) => tx(l, x, 772, 7, 'b', al))
  tx('C.P. N-1', 23, 782, 7, 'b'); tx('C.P. N', 23, 792, 7, 'b')
  tx('R.T.T.', 343, 782, 7, 'b'); tx('R.C.', 343, 792, 7, 'b')
  const lv = d.leave
  if (lv) {
    // « Pris » ventilé N-1 d'abord puis N — même règle que le moteur et les autres modèles.
    const prisN1 = Math.min(lv.cpN1Acquis || 0, lv.cumulCongesPris || 0)
    const prisN = (lv.cumulCongesPris || 0) > (lv.cpN1Acquis || 0) ? lv.cumulCongesPris - lv.cpN1Acquis : 0
    tx(encNum(lv.cpN1Acquis, 3), 97, 782, 7, 'n', 'r')
    tx(encNum(prisN1, 3), 197, 782, 7, 'n', 'r')
    tx(encNum(lv.cpN1Solde, 3), 247, 782, 7, 'n', 'r')
    tx(encNum(lv.cpNAcquis, 3), 147, 792, 7, 'n', 'r')
    tx(encNum(prisN, 3), 197, 792, 7, 'n', 'r')
    tx(encNum(lv.cpNSolde, 3), 247, 792, 7, 'n', 'r')
    if ((lv.rttAcquis || 0) > 0 || (lv.cumulRttPris || 0) > 0) {
      tx(encNum(lv.rttAcquis, 3), 467, 782, 7, 'n', 'r')
      tx(encNum(lv.cumulRttPris, 3), 517, 782, 7, 'n', 'r')
      tx(encNum(lv.rttSolde, 3, true), 567, 782, 7, 'n', 'r')
    }
  }

  tx('DANS VOTRE INTERET ET POUR VOUS AIDER A FAIRE VALOIR VOS DROITS, CONSERVEZ CE BULLETIN DE PAIE SANS LIMITATION DE DUREE.', 84.6, 816, 6)
  tx(MENTION_SERVICE_PUBLIC, 292, 825, 6, 'n', 'c')

  return { w: 595.28, h: 841.89, ops: ops.concat(texts) }
}

/** Trace `layoutEncadre` avec jsPDF (unité : point). */
function buildEncadreDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options = {}) {
  const doc = new JsPDF('p', 'pt', 'a4')
  patchTradText(doc)
  const { ops } = layoutEncadre(data, employerInfo, employeeInfo, month, year)
  const KAPPA = 0.5523
  ops.forEach((o) => {
    if (o.k === 'rr') {
      doc.setDrawColor(0, 0, 0)
      if (o.lw) doc.setLineWidth(o.lw)
      if (o.fill != null) doc.setFillColor(o.fill, o.fill, o.fill)
      doc.roundedRect(o.x, o.y, o.w, o.h, o.r, o.r, o.fill != null ? (o.lw ? 'FD' : 'F') : 'S')
    } else if (o.k === 'ln') {
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(o.lw)
      doc.line(o.x1, o.y1, o.x2, o.y2)
    } else if (o.k === 'lb') {
      // Côté gauche, quart de cercle, puis côté bas — le relief des tableaux de l'original.
      const k = KAPPA * o.r
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(o.lw)
      doc.lines([[0, o.y1 - o.r - o.y0], [0, k, o.r - k, o.r, o.r, o.r], [o.x1 - o.x - o.r, 0]], o.x, o.y0, [1, 1], 'S', false)
    } else if (o.k === 'tx') {
      doc.setFont('helvetica', o.st === 'b' ? 'bold' : o.st === 'i' ? 'italic' : 'normal')
      doc.setFontSize(o.size); doc.setTextColor(0, 0, 0)
      const w = o.al === 'l' ? 0 : doc.getTextWidth(o.s)
      doc.text(o.s, o.al === 'r' ? o.x - w : o.al === 'c' ? o.x - w / 2 : o.x, o.y)
    }
  })

  // Filigrane d'aperçu non payé — même dispositif que les autres modèles
  // (positions converties des millimètres en points). Inopérant sous Deno.
  if (options.watermark) {
    try { doc.setGState(new doc.GState({ opacity: 0.13 })) } catch { /* Deno : ignoré */ }
    doc.setTextColor(180, 40, 40); doc.setFont('helvetica', 'bold'); doc.setFontSize(30)
    for (let k = 0; k < 5; k++) doc.text('SPÉCIMEN — NON PAYÉ', 62.36, 170.08 + k * 147.4, { angle: 33 })
    try { doc.setGState(new doc.GState({ opacity: 1 })) } catch { /* Deno : ignoré */ }
  }
  return doc
}


/* ═══════════════════════════════════════════════════════════════════════════
   MODÈLE « COLONNES » — en-tête bleu, tableau Libellé / Base / Taux / Montant /
   Charges patronales, une seule page.

   Mise en page des bulletins des logiciels de paie de gestion courante :
   cadre employeur, titre et période en bleu à droite, identité du salarié en
   libellés bleus, tableau à bandeau bleu (rubriques en gras, lignes en
   italique, bandeaux gris des nets), bloc impôt sur le revenu en fin de
   tableau, puis cumuls période / annuel, net à payer, total versé et congés.

   Relevé le 11/10/2026 sur un bulletin de référence d'une page : géométrie lue
   DANS LE FLUX PDF (re / m / l / Td / Tf) — colonnes, hauteur de ligne de
   12,756 pt, bleu (54, 95, 145), gris 192, Helvetica / Bold / Oblique. Nombres
   au point décimal sans séparateur de milliers, taux à 4 décimales, comme
   l'original. STRUCTURE uniquement : aucune valeur, aucun nom, aucune marque
   d'éditeur n'en est reprise.

   Une page garantie : au-delà de 34 lignes, l'interligne et le corps se
   resserrent ensemble.
   ═══════════════════════════════════════════════════════════════════════════ */

const COL_BLEU = [54, 95, 145]
const COL_GRIS = [192, 192, 192]
const COL_BLANC = [255, 255, 255]
/** Bords des colonnes du tableau : Libellé | Base | Taux | Montant | Taux pat. | Montant pat. */
const COL_X = [21.26, 333.071, 385.512, 428.032, 477.638, 520.158, 574.016]
/** Bords droits des nombres (le texte de l'original s'arrête 0,04 pt avant sa cellule). */
const COL_R = { base: 383.47, taux: 425.99, amt: 475.6, tpat: 518.12, mpat: 571.98 }
const COL_TOP = 254.126
const COL_PITCH = 12.756
const COL_FIN = 687.83
const COL_CADRE_BAS = 693.32

/** « 3242.62 », « -214.01 » : point décimal, sans séparateur — '' si nul sauf `keepZero`. */
function colNum(v, dec = 2, keepZero = false) {
  const n = parseFloat(v)
  if (!Number.isFinite(n) || (!keepZero && Math.abs(n) < 0.0005)) return ''
  return (Math.abs(n) < 0.0005 ? 0 : n).toFixed(dec)
}

/** Intitulés des lignes de cotisation ; plusieurs lignes du moteur peuvent fusionner en une. */
const COL_INTITULES = [
  [/^Sécurité Sociale - Maladie/i, 'Sécurité Sociale - Maladie Maternité Invalidité Décès'],
  [/^Sécurité Sociale Plafonnée/i, 'Sécurité Sociale plafonnée'],
  [/^Sécurité Sociale Déplafonnée/i, 'Sécurité Sociale déplafonnée'],
  [/^(Complémentaire Tranche (A|1)|CEG Tranche 1)\b/i, 'Complémentaire Tranche 1'],
  [/^(Complémentaire Tranche 2|CEG Tranche 2)\b/i, 'Complémentaire Tranche 2'],
  [/équilibre technique|\(CET\)/i, 'Complémentaire CET'],
  [/^(Chômage|AGS)$/i, 'Chômage'],
  // Intitulés réglementaires du bulletin clarifié (arrêté du 25/02/2016).
  [/pr[ée]voyance/i, 'Complémentaire Incapacité Invalidité Décès'],
  [/mutuelle|compl[ée]mentaire sant[ée]|frais de sant[ée]/i, 'Complémentaire Santé'],
]
const COL_RANG_RETRAITE = ['Sécurité Sociale plafonnée', 'Sécurité Sociale déplafonnée', 'Complémentaire Tranche 1', 'Complémentaire Tranche 2', 'Complémentaire CET']
const COL_ORDRE = ['Santé', '__AT__', 'Retraite', 'Famille - Sécurité sociale', 'Assurance chômage', '__AUTRES_INCONNUES__', "Autres contributions dues par l'employeur", 'CSG/CRDS']
const COL_RUBRIQUES = {
  'Santé': 'SANTE', 'Retraite': 'RETRAITE', 'Famille - Sécurité sociale': 'FAMILLE',
  'Assurance chômage': 'ASSURANCE CHOMAGE', "Autres contributions dues par l'employeur": "AUTRES CONTRIBUTIONS DUES PAR L'EMPLOYEUR",
}

/** Convention applicable : { idcc, name } ou null (régime général / aucune). */
const CCN_ANCIENNES = { Syntec: 'IDCC1486', HCR: 'IDCC1979' }
function conventionApplicable(emp) {
  const conv = CCN_ANCIENNES[emp.convention] || emp.convention || (emp.conventionIdcc ? `IDCC${emp.conventionIdcc}` : 'GENERAL')
  let idcc = conv === 'CUSTOM'
    ? String(emp.customConventionIdcc || emp.conventionIdcc || '').replace(/\D/g, '')
    : String(emp.conventionIdcc || (/^IDCC(\d{1,4})$/.exec(conv) || [])[1] || '').replace(/\D/g, '')
  if (idcc) idcc = idcc.padStart(4, '0')
  if (conv === 'GENERAL' || !idcc || idcc === '0000') return null
  return { idcc, name: String(emp.conventionName || '').trim() }
}

/**
 * Éléments de salaire d'un bulletin « clarifié » (modèles colonnes et cabinet
 * clarifié) : salaire du mois complet, puis absences et entrée/sortie en lignes
 * négatives — leur somme redonne EXACTEMENT le salaire de base du moteur —,
 * heures sup., primes, congés payés. Lignes { kind: 'pay', role, label, base?,
 * taux?, amt } ; `role` permet à chaque modèle de choisir ses libellés.
 */
function gainsClarifies(d) {
  const rows = []
  const push = (o) => rows.push(o)
  const hs = parseFloat(d.heuresSupp) || 0
  const taux = parseFloat(d.tauxHoraire) || 0
  // Salaire du mois complet, puis absences et entrée/sortie en lignes négatives :
  // leur somme redonne EXACTEMENT le salaire de base calculé par le moteur.
  const contrat = parseFloat(d.horaireContractuel ?? d.horaireMensuel) || 0
  const base = parseFloat(d.salaireBase) || 0
  const avecAbsences = (d.absencesLignes || []).some((a) => (parseFloat(a.heures) || 0) > 0)
  // Mois complet sans absence : le salaire de base EST le mensuel (évite une ligne
  // fantôme à ±0,01 € sur les bulletins enregistrés avant salaireMensuelContractuel).
  const plein = !d.proration?.partial && !avecAbsences ? base
    : parseFloat(d.salaireMensuelContractuel) || Math.round(contrat * taux * 100) / 100
  push({ kind: 'pay', role: 'base', heures: contrat, label: `Salaire Mensuel ${contrat.toFixed(3).replace('.', ',')} heures`, amt: plein })
  const absences = (d.absencesLignes || []).filter((a) => (parseFloat(a.heures) || 0) > 0)
    .map((a) => {
      const lib = String(a.label || '').trim()
      return { kind: 'pay', role: 'absence', label: /^absence/i.test(lib) ? lib : `Absence ${lib || 'non rémunérée'}`, base: parseFloat(a.heures), taux, amt: -Math.round(parseFloat(a.heures) * taux * 100) / 100 }
    })
  let reste = Math.round((base - plein - absences.reduce((s, a) => s + a.amt, 0)) * 100) / 100
  if (Math.abs(reste) >= 0.005 && !d.proration?.partial && absences.length) {
    absences[absences.length - 1].amt = Math.round((absences[absences.length - 1].amt + reste) * 100) / 100
    reste = 0
  }
  absences.forEach(push)
  if (Math.abs(reste) >= 0.005) push({ kind: 'pay', role: 'entreeSortie', label: 'Absence Entrée / Sortie, salarié mensuel', amt: reste })
  if (d.heuresSuppLignes && d.heuresSuppLignes.length > 0) {
    d.heuresSuppLignes.forEach((l) => {
      if ((l.heures || 0) > 0) push({ kind: 'pay', role: 'hs', label: l.label || `Heures supplémentaires ${l.tauxMult}%`, base: l.heures, taux: l.computedTauxHS, amt: l.brut })
    })
  } else if (hs > 0) {
    push({ kind: 'pay', role: 'hs', label: 'Heures supplémentaires', base: hs, taux: d.tauxHS, amt: d.hsBrut })
  }
  if (d.primes && d.primes.length > 0) {
    d.primes.forEach((p) => { if (Math.abs(parseFloat(p.montant) || 0) >= 0.005) push({ kind: 'pay', role: 'prime', label: p.label || 'Prime', amt: p.montant }) })
  } else if (d.primeExceptionnelle > 0) {
    push({ kind: 'pay', role: 'prime', label: 'Prime exceptionnelle', amt: d.primeExceptionnelle })
  }
  const cpCol = lignesCongesPayes(d)
  if (cpCol) {
    push({ kind: 'pay', role: 'cpAbsence', label: cpCol.absence, labelCourt: cpCol.absenceCourt, base: cpCol.jours, amt: -cpCol.retenue })
    push({ kind: 'pay', role: 'cpIndemnite', label: cpCol.indemnite, base: cpCol.jours, amt: cpCol.montant })
  }
  return rows
}

/**
 * Rubriques de cotisations d'un bulletin « clarifié » (arrêté du 25/02/2016),
 * regroupées et fusionnées comme sur les logiciels du marché : lignes 'head'
 * (rubrique, éventuellement chiffrée) et 'sub', puis exonérations / allègements.
 * Apprenti : part salariale NOMINALE (base × taux) par ligne, l'exonération sur
 * sa propre ligne. Partagé par les modèles colonnes et cabinet clarifié.
 */
function rubriquesClarifiees(d) {
  const rows = []
  const push = (o) => rows.push(o)
  // Rubriques de cotisations : regroupées et fusionnées comme sur l'original.
  // Apprenti : le moteur réduit chaque part salariale (art. L.6243-2) en gardant
  // le taux nominal ; on imprime la part NOMINALE (base × taux) pour que chaque
  // ligne se vérifie, et l'exonération sur sa propre ligne plus bas.
  const partSal = (c) => (d.isApprenti && (parseFloat(c.tauxSal) || 0) > 0
    ? Math.round((((parseFloat(c.base) || 0) * (parseFloat(c.tauxSal) || 0) / 100) + Number.EPSILON) * 100) / 100
    : parseFloat(c.partSal) || 0)
  let exoApprenti = 0
  const valeurs = (c) => {
    const ps = partSal(c)
    if (d.isApprenti) exoApprenti += ps - (parseFloat(c.partSal) || 0)
    return { base: c.base, taux: c.tauxSal, amt: ps > 0 ? -ps : 0, tpat: c.tauxPat, mpat: c.partPat > 0 ? -c.partPat : 0 }
  }
  const groupes = new Map()
  fusionCsgPsc(d.cotisations).forEach((c) => {
    const cat = /^accident/i.test(c.name || '') ? '__AT__' : (c.category || '')
    if (!groupes.has(cat)) groupes.set(cat, [])
    groupes.get(cat).push(c)
  })
  const fusionner = (items) => {
    const out = []
    items.forEach((c) => {
      const regle = COL_INTITULES.find(([re]) => re.test(c.name || ''))
      const nom = regle ? regle[1] : (c.name || '')
      const v = valeurs(c)
      const deja = out.find((o) => o.label === nom && Math.abs((parseFloat(o.base) || 0) - (parseFloat(v.base) || 0)) < 0.005)
      if (deja) {
        const r4 = (x) => Math.round(x * 10000) / 10000
        const r2 = (x) => Math.round(x * 100) / 100
        deja.taux = r4((parseFloat(deja.taux) || 0) + (parseFloat(v.taux) || 0))
        deja.amt = r2((deja.amt || 0) + (v.amt || 0))
        deja.tpat = r4((parseFloat(deja.tpat) || 0) + (parseFloat(v.tpat) || 0))
        deja.mpat = r2((deja.mpat || 0) + (v.mpat || 0))
      } else {
        out.push({ label: nom, ...v })
      }
    })
    return out
  }
  const connues = new Set(COL_ORDRE)
  const ordre = []
  COL_ORDRE.forEach((cat) => {
    if (cat === '__AUTRES_INCONNUES__') { for (const k of groupes.keys()) if (!connues.has(k)) ordre.push(k) } else if (groupes.has(cat)) ordre.push(cat)
  })
  ordre.forEach((cat) => {
    const items = groupes.get(cat)
    if (cat === '__AT__') {
      items.forEach((c) => push({ kind: 'head', label: 'ACCIDENT DU TRAVAIL-MALADIES PROFESSIONNELLES', ...valeurs(c) }))
    } else if (cat === 'CSG/CRDS') {
      items.forEach((c) => {
        const nom = c.name || ''
        const label = /non imposable/i.test(nom) ? "CSG déductible de l'impôt sur le revenu"
          : /imposable/i.test(nom) ? "CSG/CRDS non déductible de l'impôt sur le revenu" : nom
        push({ kind: 'head', label, ...valeurs(c) })
      })
    } else if (cat === "Autres contributions dues par l'employeur") {
      const total = items.reduce((s, c) => s + (parseFloat(c.partPat) || 0), 0)
      push({ kind: 'head', label: COL_RUBRIQUES[cat], mpat: total > 0 ? -Math.round(total * 100) / 100 : 0 })
    } else if (cat === 'Famille - Sécurité sociale' && items.length === 1) {
      push({ kind: 'head', label: COL_RUBRIQUES[cat], ...valeurs(items[0]) })
    } else {
      let lignes = fusionner(items)
      if (cat === 'Retraite') {
        const rang = (l) => { const i = COL_RANG_RETRAITE.indexOf(l.label); return i < 0 ? 99 : i }
        lignes = lignes.map((l, i) => ({ l, i })).sort((a, b) => rang(a.l) - rang(b.l) || a.i - b.i).map((x) => x.l)
      }
      push({ kind: 'head', label: COL_RUBRIQUES[cat] || encCaps(cat) })
      lignes.forEach((l) => push({ kind: 'sub', ...l }))
    }
  })
  const exoSal = parseFloat(d.exoCotisSalHS) || 0
  const exoApp = Math.round(exoApprenti * 100) / 100
  const exoPat = Math.round(((parseFloat(d.allegementPatHS) || 0) + (parseFloat(d.reductionGenerale) || 0)) * 100) / 100
  if (exoPat > 0 || exoSal > 0 || exoApp > 0) {
    push({ kind: 'head', label: 'EXONERATIONS, ECRETEMENTS ET ALLEGEMENTS DE COTISATIONS', mpat: exoPat > 0 ? exoPat : 0 })
    if (exoSal > 0) push({ kind: 'pay', label: 'Réduction salariale heures supplémentaires, heures complémentaires', base: d.hsBrut, taux: d.tauxExoSal, amt: exoSal })
    if (exoApp > 0) push({ kind: 'pay', label: 'Exonération de cotisations salariales apprenti', amt: exoApp })
  }

  return rows
}

/* ── Modèle de l'article 1 de l'arrêté du 25/02/2016 (rédaction de l'arrêté du
   31/01/2023, JORFTEXT000047096915), OBLIGATOIRE pour les rémunérations versées
   à compter du 01/01/2027 : le modèle dérogatoire de l'article 2 (celui des
   autres modèles Salareo) n'est admis que jusqu'au 1er janvier 2027 (arrêté du
   11/08/2025, JORFTEXT000052097236). Libellés et ordre recopiés du texte. ── */
export const DATE_MODELE_2027 = '2027-01-01'

/** Date de versement ISO du bulletin : saisie, sinon dernier jour ouvré du mois. */
function dateVersementIso(data, month, year) {
  const s = String(data?.datePaiement || '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : datePaiementParDefaut(year, month)
}

/** Modèle réellement imprimé : celui de l'article 1 pour tout versement à compter du 01/01/2027. */
export function modeleApplicable(template, data, month, year) {
  return dateVersementIso(data, month, year) >= DATE_MODELE_2027 ? 'officiel2027' : (template || 'classic')
}

const P27_LIGNES = [
  [/pr[ée]voyance/i, 'Prévoyance, Incapacité, Invalidité, Décès, Autres'],
  [/^Sécurité Sociale - Maladie/i, 'Sécurité Sociale Maladie Maternité Invalidité Décès'],
  [/mutuelle|compl[ée]mentaire sant[ée]|frais de sant[ée]/i, 'Complémentaire garanties frais de santé obligatoire'],
  [/^accident/i, 'Accidents du travail & maladies professionnelles'],
  [/^Sécurité Sociale Plafonnée/i, 'Sécurité Sociale Vieillesse plafonnée'],
  [/^Sécurité Sociale Déplafonnée/i, 'Sécurité Sociale Vieillesse déplafonnée'],
  [/^(Complémentaire Tranche (A|1)|CEG Tranche 1)\b/i, 'Retraite complémentaire, CEG et CET T1'],
  [/^(Complémentaire Tranche 2|CEG Tranche 2)\b/i, 'Retraite complémentaire, CEG et CET T2'],
  [/équilibre technique|\(CET\)/i, '__CET__'],
  [/^Allocations familiales/i, 'Famille'],
  [/^(Chômage|AGS)$/i, 'Assurance chômage'],
  [/^APEC$/i, 'Apec'],
]
const P27_SANTE = ['Sécurité Sociale Maladie Maternité Invalidité Décès', 'Complémentaire garanties frais de santé obligatoire', 'Accidents du travail & maladies professionnelles']
const P27_RETRAITE = ['Sécurité Sociale Vieillesse plafonnée', 'Sécurité Sociale Vieillesse déplafonnée', 'Retraite complémentaire, CEG et CET T1', 'Retraite complémentaire, CEG et CET T2']
const P27_SEULES = ['Famille', 'Assurance chômage', 'Apec']
const P27_CONV = 'Cotisations statutaires ou prévues par la convention collective'
const P27_PREV = 'Prévoyance, Incapacité, Invalidité, Décès, Autres'
const P27_COLS = (titre, dernier = 'Employeur') => [titre, 'Base', 'Taux', 'Salarié', dernier]

/**
 * Lignes de cotisations du modèle 2027 (format des lignes de layoutColonnes :
 * montants salariaux et patronaux NÉGATIFS, exonérations positives). Le total
 * des obligatoires est AVANT exonérations (ordre du texte) ; la somme de toutes
 * les lignes redonne le net avant impôt du moteur (contrôlé par les tests).
 */
export function rubriques2027(d) {
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100
  const r4 = (x) => Math.round(x * 10000) / 10000
  const n = (x) => parseFloat(x) || 0
  // Apprenti : part salariale NOMINALE (base × taux), l'exonération en ligne dédiée
  // (même règle que les modèles clarifiés).
  let exoApprenti = 0
  const partSal = (c) => {
    const ps = d.isApprenti && n(c.tauxSal) > 0 ? r2(n(c.base) * n(c.tauxSal) / 100) : n(c.partSal)
    if (d.isApprenti) exoApprenti += ps - n(c.partSal)
    return ps
  }
  const lignes = new Map() // libellé du modèle → { base, taux, sal, tpat, pat, ordre }
  const ajoute = (label, base, tauxSal, sal, tauxPat, pat) => {
    const l = lignes.get(label)
    if (!l) { lignes.set(label, { label, base: n(base), taux: n(tauxSal), sal, tpat: n(tauxPat), pat }); return }
    if (Math.abs(l.base - n(base)) >= 0.005) l.baseMixte = true
    l.taux = r4(l.taux + n(tauxSal)); l.tpat = r4(l.tpat + n(tauxPat))
    l.sal = r2(l.sal + sal); l.pat = r2(l.pat + pat)
  }
  const cot = fusionCsgPsc(d.cotisations)
  const baseT1 = n(cot.find((c) => /^(Complémentaire Tranche (A|1)|CEG Tranche 1)\b/i.test(c.name || ''))?.base)
  let autresPat = 0
  const csg = []
  cot.forEach((c) => {
    const nom = c.name || ''
    if (c.isCSG || c.category === 'CSG/CRDS') { csg.push(c); return }
    if (c.category === "Autres contributions dues par l'employeur") { autresPat += n(c.partPat); return }
    const regle = P27_LIGNES.find(([re]) => re.test(nom))
    const sal = partSal(c)
    if (regle && regle[1] === '__CET__') {
      // CET répartie sur T1 et T2 (« Retraite complémentaire, CEG et CET T1/T2 »).
      const b = n(c.base)
      const b1 = Math.min(b, baseT1 || b)
      const s1 = b > 0 ? r2(sal * b1 / b) : sal
      const p1 = b > 0 ? r2(n(c.partPat) * b1 / b) : n(c.partPat)
      ajoute('Retraite complémentaire, CEG et CET T1', b1, c.tauxSal, s1, c.tauxPat, p1)
      if (b - b1 >= 0.005) ajoute('Retraite complémentaire, CEG et CET T2', r2(b - b1), c.tauxSal, r2(sal - s1), c.tauxPat, r2(n(c.partPat) - p1))
      return
    }
    ajoute(regle ? regle[1] : `${P27_CONV}|${nom}`, c.base, c.tauxSal, sal, c.tauxPat, n(c.partPat))
  })

  // CSG/CRDS : déductible, non déductible, et part afférente aux heures sup.
  // exonérées d'impôt (revenus non imposables) — même prorata que le moteur
  // (csgDeductibleHS = CSG déductible × HS / brut).
  const hsBrut = n(d.hsBrut), brut = n(d.totalBrut)
  const potentiel = n(d.montantNetHSPotentiel)
  const fracHS = hsBrut > 0 && brut > 0 && potentiel > 0 ? (hsBrut / brut) * Math.min(1, n(d.montantNetHSExonere) / potentiel) : 0
  const lignesCsg = []
  csg.forEach((c) => {
    const nom = c.name || ''
    const sal = partSal(c)
    if (/non imposable/i.test(nom) || (c.isCSG && !c.isImposable && !/imposable/i.test(nom))) {
      lignesCsg.push({ label: "CSG déductible de l'impôt sur le revenu", base: c.base, taux: c.tauxSal, sal })
    } else if (fracHS > 0) {
      const bHS = r2(n(c.base) * fracHS)
      const sHS = r2(bHS * n(c.tauxSal) / 100)
      lignesCsg.push({ label: "CSG/ CRDS non déductible de l'impôt sur le revenu", base: r2(n(c.base) - bHS), taux: c.tauxSal, sal: r2(sal - sHS) })
      lignesCsg.push({ label: 'CSG/ CRDS sur les revenus non imposables', base: bHS, taux: c.tauxSal, sal: sHS })
    } else {
      lignesCsg.push({ label: "CSG/ CRDS non déductible de l'impôt sur le revenu", base: c.base, taux: c.tauxSal, sal })
    }
  })

  const rows = []
  const val = (l) => ({ base: l.baseMixte ? null : l.base, taux: l.taux, amt: l.sal > 0 ? -l.sal : 0, tpat: l.tpat, mpat: l.pat > 0 ? -l.pat : 0 })
  let totSal = 0, totPat = 0
  const compte = (l) => { totSal += n(l.sal); totPat += n(l.pat) }
  rows.push({ kind: 'sect', cols: P27_COLS('COTISATIONS ET CONTRIBUTIONS SOCIALES OBLIGATOIRES') })
  for (const [titre, liste] of [['Santé', P27_SANTE], ['Retraite', P27_RETRAITE]]) {
    const presentes = liste.filter((k) => lignes.has(k))
    if (!presentes.length) continue
    rows.push({ kind: 'head', label: titre })
    presentes.forEach((k) => { const l = lignes.get(k); compte(l); rows.push({ kind: 'sub', label: k, ...val(l) }) })
  }
  P27_SEULES.forEach((k) => { if (lignes.has(k)) { const l = lignes.get(k); compte(l); rows.push({ kind: 'head', label: k, ...val(l) }) } })
  if (autresPat > 0) { totPat += autresPat; rows.push({ kind: 'head', label: "Autres charges dues par l'employeur", mpat: -r2(autresPat) }) }
  const conv = [...lignes.keys()].filter((k) => k.startsWith(`${P27_CONV}|`))
  if (conv.length) {
    rows.push({ kind: 'head', label: P27_CONV })
    conv.forEach((k) => { const l = lignes.get(k); compte(l); rows.push({ kind: 'sub', ...val(l), label: k.slice(P27_CONV.length + 1) }) })
  }
  lignesCsg.forEach((l) => { totSal += n(l.sal); rows.push({ kind: 'head', label: l.label, base: l.base, taux: l.taux, amt: l.sal > 0 ? -l.sal : 0 }) })
  rows.push({ kind: 'total', label: 'TOTAL DES COTISATIONS ET CONTRIBUTIONS OBLIGATOIRES', amt: -r2(totSal), mpat: -r2(totPat) })

  const exoSal = r2(n(d.exoCotisSalHS) + exoApprenti)
  const exoPat = r2(n(d.allegementPatHS) + n(d.reductionGenerale))
  if (exoSal > 0 || exoPat > 0) rows.push({ kind: 'head', label: 'EXONÉRATIONS ET ALLÈGEMENTS DE COTISATIONS', amt: exoSal > 0 ? exoSal : 0, mpat: exoPat > 0 ? exoPat : 0 })

  if (lignes.has(P27_PREV)) {
    rows.push({ kind: 'sect', cols: P27_COLS('COTISATIONS ET CONTRIBUTIONS SOCIALES FACULTATIVES') })
    rows.push({ kind: 'head', label: P27_PREV, ...val(lignes.get(P27_PREV)) })
  }
  return rows
}

/**
 * Description complète de la page (points, origine en haut à gauche, A4).
 * @returns {{ w: number, h: number, ops: Array<object> }}
 *   ops : { k:'rect', x,y,w,h, fill:[r,g,b]|null, stroke:[r,g,b]|null, lw }
 *         { k:'line', x1,y1,x2,y2, lw, col:[r,g,b] }
 *         { k:'tx', s, x, y, size, st:'n'|'b'|'i', al:'l'|'r'|'c', col:[r,g,b] }
 */
export function layoutColonnes(data, employerInfo, employeeInfo, month, year, opts = {}) {
  const m27 = !!opts.modele2027
  const d = data || {}
  const emp = employerInfo || {}
  const sal = employeeInfo || {}
  const ops = []
  const texts = []
  const rect = (x, y, w, h, fill, stroke = null, lw = 0.5) => ops.push({ k: 'rect', x, y, w, h, fill, stroke, lw })
  const line = (x1, y1, x2, y2, lw = 0.5, col = COL_BLEU) => ops.push({ k: 'line', x1, y1, x2, y2, lw, col })
  const tx = (s, x, y, size, st = 'n', al = 'l', col = [0, 0, 0]) => {
    const t = s == null ? '' : String(s)
    if (t.trim()) texts.push({ k: 'tx', s: t, x, y, size, st, al, col })
  }

  // ── Période et totaux de référence ────────────────────────────────────────
  const mm = String(month + 1).padStart(2, '0')
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const periodStart = d.proration?.periodeDebut || `01/${mm}/${year}`
  const periodEnd = d.proration?.periodeFin || `${daysInMonth}/${mm}/${year}`
  const datePaie = datePaiementDe(d, month, year, periodEnd)
  const pmss = parseFloat(d.plafondSS) || ENC_PMSS[year] || 4005
  const hs = parseFloat(d.heuresSupp) || 0
  const taux = parseFloat(d.tauxHoraire) || 0

  // ── Lignes du tableau ─────────────────────────────────────────────────────
  // kind : 'pay' (élément de salaire) | 'head' (rubrique en gras) | 'sub' (ligne
  // de rubrique, italique) | 'total' | 'band' (bandeau gris) | 'irhead' | 'ir' | 'blank'
  const rows = []
  const push = (o) => rows.push(o)

  const cum = d.cumuls || {}
  if (m27) {
    // Ordre et libellés de l'article 1 ; « Montant brut » et « Montant net à
    // payer » mis en évidence (VI). Remboursements et déductions diverses :
    // aucun élément de ce type n'est saisi dans Salareo, rubrique sans objet.
    gainsClarifies(d).forEach(push)
    push({ kind: 'bandFort', label: 'MONTANT BRUT', amt: d.totalBrut })
    rubriques2027(d).forEach(push)
    push({ kind: 'band', label: 'MONTANT NET SOCIAL', amt: d.netSocial })
    push({ kind: 'band', label: 'MONTANT NET A PAYER AVANT IMPOT SUR LE REVENU', amt: d.netAvantIR })
    push({ kind: 'sect', cols: P27_COLS('IMPOT SUR LE REVENU', 'Cumul annuel') })
    push({ kind: 'ir', label: 'Montant net imposable', amt: d.baseIR, keep: true, cumul: cum.netImposable })
    push({ kind: 'ir', label: 'Montant net des HC/ HS/ RTT exonérées', amt: d.montantNetHSExonere || 0, keep: true, cumul: cum.hsExonere || 0 })
    push({ kind: 'ir', label: 'IMPÔT SUR LE REVENU PRÉLEVÉ À LA SOURCE', base: d.baseIR, taux: d.tauxIR, tauxKeep: true, amt: -(d.irPreleve || 0), keep: true, cumul: cum.irPreleve || 0 })
    push({ kind: 'bandFort', label: 'MONTANT NET A PAYER (en Euros)', amt: d.netAPayer })
    push({ kind: 'band', label: "TOTAL VERSÉ PAR L'EMPLOYEUR", amt: d.totalVerseEmployeur })
  } else {
  gainsClarifies(d).forEach(push)
  push({ kind: 'blank' })
  push({ kind: 'total', label: 'Total Brut', amt: d.totalBrut })
  push({ kind: 'blank' })

  rubriquesClarifiees(d).forEach(push)
  push({ kind: 'blank' })
  push({ kind: 'total', label: 'Total des cotisations et contributions sociales', amt: -(d.totalCotisSal || 0), mpat: -(d.totalCotisPat || 0) })
  push({ kind: 'blank' })
  // Part patronale frais de santé ajoutée au net imposable (information seule :
  // n'entre pas dans le net social / à payer) — même place que sur Sage.
  if ((parseFloat(d.reintegrationSante) || 0) > 0) {
    push({ kind: 'pay', label: 'Réintégration fiscale complémentaire santé', amt: d.reintegrationSante })
  }
  push({ kind: 'band', label: 'Montant Net social', amt: d.netSocial })
  push({ kind: 'blank' })
  push({ kind: 'band', label: 'Net à payer avant impôt', amt: d.netAvantIR })
  push({ kind: 'blank' })
  push({ kind: 'irhead' })
  push({ kind: 'ir', label: 'Montant net imposable', amt: d.baseIR, keep: true, cumul: cum.netImposable })
  push({ kind: 'ir', label: 'Montant net des heures compl/suppl exonérées', amt: d.montantNetHSExonere || 0, keep: true, cumul: cum.hsExonere || 0 })
  push({ kind: 'ir', label: `Impôt sur le revenu prélevé à la source (taux d'imposition ${d.irAuto === false ? 'personnalisé' : 'calculé selon barème'})`,
    base: d.baseIR, taux: d.tauxIR, tauxKeep: true, amt: -(d.irPreleve || 0), keep: true, cumul: cum.irPreleve || 0 })
  }

  // ── Pas de ligne et corps : 34 lignes à 12,756 pt, resserrées au-delà ─────
  const pitch = rows.length > 0 ? Math.min(COL_PITCH, (COL_FIN - COL_TOP) / rows.length) : COL_PITCH
  const sc = pitch / COL_PITCH
  const fs = Math.max(5.5, 7.999 * sc)
  const fsBand = Math.max(6, 8.999 * sc)
  const yTop = (i) => COL_TOP + i * pitch

  // ── Cadres et bandeaux ────────────────────────────────────────────────────
  // Cadre employeur
  line(21.39, 28.47, 269.29, 28.47, 0.25); line(21.39, 28.47, 21.39, 110.55, 0.25)
  line(21.39, 110.55, 269.29, 110.55); line(269.29, 28.47, 269.29, 110.55)
  // Bandeau des colonnes
  rect(COL_X[0], 237.118, COL_X[6] - COL_X[0], 17.008, COL_BLEU)
  ;[1, 2, 3, 4].forEach((i) => line(COL_X[i], 237.12, COL_X[i], 254.13, 0.5, COL_BLANC))
  // Bandeaux gris (nets, en-tête impôt) et leurs filets
  const coupures = []
  rows.forEach((r, i) => {
    if (!['band', 'bandFort', 'irhead', 'sect'].includes(r.kind)) return
    rect(COL_X[0], yTop(i), COL_X[6] - COL_X[0], pitch, r.kind === 'bandFort' ? COL_BLEU : COL_GRIS)
    line(COL_X[0], yTop(i), COL_X[6], yTop(i)); line(COL_X[0], yTop(i + 1), COL_X[6], yTop(i + 1))
    if (r.kind === 'band' || r.kind === 'bandFort') coupures.push([yTop(i), yTop(i + 1)])
  })
  const fin = rows.length ? yTop(rows.length) : COL_FIN
  line(COL_X[0], fin, COL_X[6], fin)
  // Bas du cadre : ligne de remplissage de 5,49 pt sous la dernière ligne, comme
  // l'original (680,56 à 33 lignes, 693,32 à 34) ; jamais plus haut que 680,56.
  const bas = Math.min(COL_CADRE_BAS, Math.max(fin + 5.491, 680.562))
  // Filets verticaux : interrompus sur les bandeaux des nets ; aucun dans « Charges patronales ».
  ;[1, 2, 3, 4].forEach((i) => {
    let y0 = COL_TOP
    coupures.forEach(([a, b]) => { if (a > y0) line(COL_X[i], y0, COL_X[i], a); y0 = b })
    line(COL_X[i], y0, COL_X[i], bas)
  })
  // Cadre du corps
  line(21.39, 254.25, 573.89, 254.25, 0.25); line(21.39, 254.25, 21.39, bas, 0.25)
  line(21.39, bas, 573.89, bas, 0.25); line(573.89, 254.25, 573.89, bas, 0.25)

  // ── En-tête ───────────────────────────────────────────────────────────────
  const raison = emp.raisonSociale || emp.nom || ''
  tx(encClip(raison, 9, 236), 28.96, 44.19, 9)
  tx(encClip(emp.adresse, 9, 236), 28.96, 58.3, 9)
  tx(encClip([emp.codePostal, emp.ville].filter(Boolean).join(' '), 9, 236), 28.96, 86.67, 9)
  const siret = String(emp.siret || '').replace(/\s/g, '')
  tx(encClip(`SIRET : ${siret}${emp.codeAPE ? `    APE : ${emp.codeAPE}` : ''}`, 9, 236), 28.96, 100.85, 9)

  const centre = 346.77 + encW('BULLETIN DE PAIE', 19, true) / 2
  tx('BULLETIN DE PAIE', centre, 48.94, 19, 'b', 'c', COL_BLEU)
  tx(`Période du ${periodStart} au ${periodEnd}`, centre, 70.11, 10, 'n', 'c', COL_BLEU)
  const mode = String(d.modePaiement || emp.modePaiement || 'Virement').replace(/\s*bancaire$/i, '')
  tx(`Paiement, le ${datePaie} par ${mode.charAt(0).toUpperCase()}${mode.slice(1).toLowerCase()}`, centre, 87.1, 10, 'n', 'c', COL_BLEU)

  ;[['Code :', 123.53, sal.matricule], ['N° Sécurité soc. :', 134.84, String(sal.numSecu || '').replace(/\s/g, '')],
    ['Emploi :', 146.21, sal.emploi], ['Niveau :', 157.51, sal.niveau], ['Coefficient :', 168.89, sal.coefficient],
    ['Indice :', 180.19, sal.echelon], ['Ancienneté :', 191.5, formatDateFR(sal.dateEntree)]].forEach(([l, y, v]) => {
    tx(l, 23.28, y, 8, 'n', 'l', COL_BLEU)
    tx(encClip(v, 8, 190), 97.8, y, 8)
  })

  const sexe = String(sal.sexe || '')
  const civ = sexe === '2' || sexe === 'F' ? 'Mme' : sexe === '1' || sexe === 'M' ? 'M.' : ''
  const nomComplet = [civ, String(sal.nom || '').toUpperCase(), String(sal.prenom || '').toUpperCase()].filter(Boolean).join(' ')
  tx(encClip(nomComplet, 10, 262), 308.11, 137.64, 10)
  tx(encClip(sal.adresse, 10, 262), 308.11, 154.63, 10)
  tx(encClip([sal.codePostal, sal.ville].filter(Boolean).join(' '), 10, 262), 308.11, 188.69, 10)

  // Convention collective (art. R.3243-1, 3°) ; l'IDCC reste toujours lisible, seul
  // l'intitulé est raccourci s'il déborde. Aucune convention → Code du travail.
  const cv = conventionApplicable(emp)
  if (cv) {
    const suffixe = ` (IDCC N°${cv.idcc})`
    const tete = 'Convention collective : '
    const sCcn = encFit(`${tete}${cv.name}${suffixe}`, 9, 550, false, 6.5)
    const nom = cv.name ? encClip(cv.name, sCcn, 550 - encW(tete + suffixe, sCcn)) : ''
    tx(nom ? `${tete}${nom}${suffixe}` : `${tete}IDCC N°${cv.idcc}`, 23.28, 233.12, sCcn)
  } else {
    tx('Convention collective : aucune (Code du travail)', 23.28, 233.12, 9)
  }

  // ── Tableau ───────────────────────────────────────────────────────────────
  ;[['Libellé', 0, 1], ['Base', 1, 2], ['Taux', 2, 3], [m27 ? 'Salarié' : 'Montant', 3, 4], [m27 ? 'Employeur' : 'Charges patronales', 4, 6]]
    .forEach(([l, a, b]) => tx(l, (COL_X[a] + COL_X[b]) / 2, 248.74, 9, 'b', 'c', COL_BLANC))

  const cellules = (r, y) => {
    tx(colNum(r.base), COL_R.base, y, fs, 'n', 'r')
    tx(colNum(r.taux, 4, r.tauxKeep), COL_R.taux, y, fs, 'n', 'r')
    tx(colNum(r.amt, 2, r.keep), COL_R.amt, y, fs, 'n', 'r')
    if (r.kind === 'ir') tx(colNum(r.cumul, 2, true), COL_R.mpat, y, fs, 'n', 'r')
    else {
      tx(colNum(r.tpat, 4), COL_R.tpat, y, fs, 'n', 'r')
      tx(colNum(r.mpat), COL_R.mpat, y, fs, 'n', 'r')
    }
  }
  const maxLib = COL_X[1] - COL_X[0] - 4
  rows.forEach((r, i) => {
    const y = yTop(i) + 9.284 * sc
    if (r.kind === 'blank') return
    if (r.kind === 'band' || r.kind === 'bandFort') {
      const c = r.kind === 'bandFort' ? COL_BLANC : [0, 0, 0]
      tx(r.label, 23.28, yTop(i) + 10.13 * sc, fsBand, 'b', 'l', c)
      tx(colNum(r.amt, 2, true), COL_R.mpat, yTop(i) + 10.13 * sc, fsBand, 'b', 'r', c)
      return
    }
    if (r.kind === 'sect') {
      const yh = yTop(i) + 9.15 * sc
      tx(encClip(r.cols[0], fs, COL_X[1] - COL_X[0] - 4, true), 23.28, yh, fs, 'b')
      ;[[1, 1, 2], [2, 2, 3], [3, 3, 4], [4, 4, 6]].forEach(([k, a, b]) => tx(r.cols[k], (COL_X[a] + COL_X[b]) / 2, yh, fs, 'n', 'c'))
      return
    }
    if (r.kind === 'irhead') {
      const yh = yTop(i) + 9.15 * sc
      ;[['Impôt sur le revenu', 0, 1], ['Base', 1, 2], ['Taux', 2, 3], ['Montant', 3, 4], ['Cumul annuel', 4, 6]]
        .forEach(([l, a, b]) => tx(l, (COL_X[a] + COL_X[b]) / 2, yh, fs, 'n', 'c'))
      return
    }
    const st = r.kind === 'head' ? 'b' : r.kind === 'sub' ? 'i' : 'n'
    const x = r.kind === 'sub' ? 27.72 : r.kind === 'total' ? 45.52 : 23.28
    tx(encClip(r.label, fs, maxLib - (x - 23.28), st === 'b'), x, y, fs, st)
    cellules(r, y)
  })

  // ── Pied : cumuls, net à payer, total versé, congés ───────────────────────
  const cumX = [[21.26, 31.206], [52.466, 42.52], [95.091, 42.52], [137.575, 42.52], [180.237, 42.52],
    [222.913, 42.52], [265.688, 42.52], [308.575, 42.52], [351.078, 42.52]]
  const entetes = ['Cumuls', 'Plafond SS', 'Brut', 'Brut abattu', 'Cotis. Sal.', 'Cotis. Pat.', 'Hres Trav.', 'Hres Pay.', 'Hres Supp.']
  cumX.forEach(([x, w], i) => {
    rect(x, 715.048, w, 12.756, COL_BLEU)
    line(x + w, 715.05, x + w, 727.8, 0.5, COL_BLANC)
    tx(entetes[i], x + w / 2, 723.41, 7, 'n', 'c', COL_BLANC)
  })
  ;[[728.568, 'Période', 736.88], [742.424, 'Annuel', 750.77]].forEach(([y, l, yb]) => {
    rect(21.26, y, 31.206, 12.756, COL_BLEU)
    tx(l, 21.26 + 31.206 / 2, yb, 7, 'n', 'c', COL_BLANC)
    cumX.slice(1).forEach(([x, w]) => {
      line(x, y, x, y + 12.756); line(x, y + 12.756, x + w, y + 12.756); line(x + w, y, x + w, y + 12.756)
    })
  })
  const heuresPay = (parseFloat(d.horaireMensuel) || 0) + hs
  const periode = [pmss, d.totalBrut, d.totalBrut, d.totalCotisSal, d.totalCotisPat]
  // Bulletins enregistrés avant ces cumuls : case laissée vide plutôt qu'une valeur reconstituée.
  const annuel = [cum.plafond, cum.brut, cum.brut, cum.cotisSal, cum.cotisPat]
  const heuresP = [heuresPay, heuresPay, hs]
  const heuresA = [cum.heures, cum.heures, cum.heuresSupp]
  cumX.slice(1).forEach(([x, w], i) => {
    const vP = i < 5 ? colNum(periode[i], 2, true) : colNum(heuresP[i - 5], 3, true)
    const brutA = i < 5 ? annuel[i] : heuresA[i - 5]
    const vA = brutA == null ? '' : i < 5 ? colNum(brutA, 2, true) : colNum(brutA, 3, true)
    tx(vP, x + w - 1.99, 736.88, 7, 'n', 'r')
    tx(vA, x + w - 1.99, 750.77, 7, 'n', 'r')
  })

  // Montant total des exonérations et allègements de cotisations (art. R.3243-1, 13°),
  // mois et cumul annuel — même gabarit que les cases des cumuls.
  rect(21.26, 758.268, 116.315, 11.339, COL_BLEU)
  tx('Allègements de cotisations', 24.5, 766.6, 7, 'n', 'l', COL_BLANC)
  ;[[137.575, d.totalAllegements], [180.237, cum.allegements]].forEach(([x, v], i) => {
    rect(x, 758.268, 42.52, 11.339, null, COL_BLEU, 0.5)
    tx(v == null && i === 1 ? '' : colNum(v || 0, 2, true), x + 42.52 - 1.99, 766.6, 7, 'n', 'r')
  })
  tx('Mois', 158.835, 775.9, 6, 'n', 'c', COL_BLEU); tx('Année', 201.497, 775.9, 6, 'n', 'c', COL_BLEU)

  rect(396.851, 704.977, 90.709, 19.559, COL_BLEU)
  tx('Net à payer', 396.851 + 90.709 / 2, 717.08, 10, 'b', 'c', COL_BLANC)
  rect(487.56, 705.26, 86.21, 19.84, null, COL_BLEU, 1)
  tx(colNum(d.netAPayer, 2, true), 571.98, 717.37, 10, 'b', 'r')
  rect(396.851, 725.669, 90.709, 11.339, COL_BLEU)
  tx("Total versé par l'employeur", 400.12, 734, 7, 'n', 'l', COL_BLANC)
  rect(487.56, 725.67, 86.33, 11.34, null, COL_BLEU, 0.5)
  tx(colNum(d.totalVerseEmployeur, 2, true), 572.02, 734, 7, 'n', 'r')

  const cgX = [[396.598, 75.118], [471.717, 34.016], [505.732, 34.016], [539.748, 34.016]]
  ;['Congés', 'Acquis', 'Pris', 'Reste'].forEach((l, i) => {
    const [x, w] = cgX[i]
    rect(x, 739.008, w, 11.339, COL_BLEU)
    if (i > 0) line(x, 739.13, x, 750.35, 0.5, COL_BLANC)
    tx(l, x + w / 2, 747.46, 8, 'n', 'c', COL_BLANC)
  })
  const lv = d.leave || {}
  const prisN1 = Math.min(lv.cpN1Acquis || 0, lv.cumulCongesPris || 0)
  const prisN = (lv.cumulCongesPris || 0) > (lv.cpN1Acquis || 0) ? lv.cumulCongesPris - lv.cpN1Acquis : 0
  const conges = [
    ['CP année N', lv.cpNAcquis, prisN, lv.cpNSolde],
    ['CP année N-1', lv.cpN1Acquis, prisN1, lv.cpN1Solde],
    ['RTT', lv.rttAcquis, lv.cumulRttPris, lv.rttSolde],
    ['Repos comp.', null, null, null],
  ]
  conges.forEach(([l, ...v], k) => {
    const y = 750.35 + k * 11.339
    cgX.forEach(([x, w]) => { line(x, y + 11.339, x + w, y + 11.339); line(x + w, y, x + w, y + 11.339) })
    line(396.72, y, 396.72, y + 11.339, 0.25)
    tx(l, 398.61, y + 8.42, 8)
    v.forEach((val, i) => tx(val == null ? '' : colNum(val || 0, 2, true), cgX[i + 1][0] + cgX[i + 1][1] - 1.98, y + 8.42, 8, 'n', 'r'))
  })

  tx('Pour vous aider à faire valoir vos droits, conservez ce bulletin de paie sans limitation de durée.', 21.26, 817.66, 7, 'n', 'l', COL_BLEU)
  tx(MENTION_SERVICE_PUBLIC, 21.26, 825.51, 7, 'n', 'l', COL_BLEU)

  return { w: 595.28, h: 841.89, ops: ops.concat(texts) }
}

/** Trace les primitives des modèles « décrits » (encadré, colonnes) avec jsPDF. */
function traceOps(doc, ops) {
  const KAPPA = 0.5523
  ops.forEach((o) => {
    if (o.k === 'rr') {
      doc.setDrawColor(0, 0, 0)
      if (o.lw) doc.setLineWidth(o.lw)
      if (o.fill != null) doc.setFillColor(o.fill, o.fill, o.fill)
      doc.roundedRect(o.x, o.y, o.w, o.h, o.r, o.r, o.fill != null ? (o.lw ? 'FD' : 'F') : 'S')
    } else if (o.k === 'ln') {
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(o.lw)
      doc.line(o.x1, o.y1, o.x2, o.y2)
    } else if (o.k === 'lb') {
      const k = KAPPA * o.r
      doc.setDrawColor(0, 0, 0); doc.setLineWidth(o.lw)
      doc.lines([[0, o.y1 - o.r - o.y0], [0, k, o.r - k, o.r, o.r, o.r], [o.x1 - o.x - o.r, 0]], o.x, o.y0, [1, 1], 'S', false)
    } else if (o.k === 'rect') {
      if (o.fill) doc.setFillColor(o.fill[0], o.fill[1], o.fill[2])
      if (o.stroke) { doc.setDrawColor(o.stroke[0], o.stroke[1], o.stroke[2]); doc.setLineWidth(o.lw || 0.5) }
      doc.rect(o.x, o.y, o.w, o.h, o.fill && o.stroke ? 'FD' : o.fill ? 'F' : 'S')
    } else if (o.k === 'el') {
      doc.setFillColor(o.fill[0], o.fill[1], o.fill[2])
      doc.ellipse(o.cx, o.cy, o.rx, o.ry, 'F')
    } else if (o.k === 'line') {
      const c = o.col || [0, 0, 0]
      doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(o.lw)
      doc.line(o.x1, o.y1, o.x2, o.y2)
    } else if (o.k === 'tx') {
      const c = o.col || [0, 0, 0]
      const fam = o.f === 'mono' ? 'courier' : 'helvetica'
      doc.setFont(fam, o.st === 'b' ? 'bold' : o.st === 'i' ? (fam === 'courier' ? 'oblique' : 'italic') : 'normal')
      doc.setFontSize(o.size); doc.setTextColor(c[0], c[1], c[2])
      // Largeurs AFM (celles qu'applique le lecteur PDF), pas getTextWidth (table
      // arrondie + crénage) : alignements identiques à l'original et à l'aperçu.
      // Courier : chasse fixe de 600/1000 em pour tous les glyphes.
      const w = o.al === 'l' ? 0 : o.f === 'mono' ? String(o.s).length * o.size * 0.6 : encW(o.s, o.size, o.st === 'b')
      doc.text(o.s, o.al === 'r' ? o.x - w : o.al === 'c' ? o.x - w / 2 : o.x, o.y)
    }
  })
}

/** Modèle de l'article 1 (obligatoire au 01/01/2027) : gabarit « colonnes », rubriques du texte. */
export function layoutOfficiel2027(data, employerInfo, employeeInfo, month, year) {
  return layoutColonnes(data, employerInfo, employeeInfo, month, year, { modele2027: true })
}

/** Trace `layoutColonnes` avec jsPDF (unité : point). */
function buildColonnesDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options = {}) {
  const doc = new JsPDF('p', 'pt', 'a4')
  patchTradText(doc)
  traceOps(doc, layoutColonnes(data, employerInfo, employeeInfo, month, year, { modele2027: !!options.modele2027 }).ops)
  // Filigrane d'aperçu non payé — même dispositif que les autres modèles. Inopérant sous Deno.
  if (options.watermark) {
    try { doc.setGState(new doc.GState({ opacity: 0.13 })) } catch { /* Deno : ignoré */ }
    doc.setTextColor(180, 40, 40); doc.setFont('helvetica', 'bold'); doc.setFontSize(30)
    for (let k = 0; k < 5; k++) doc.text('SPÉCIMEN — NON PAYÉ', 62.36, 170.08 + k * 147.4, { angle: 33 })
    try { doc.setGState(new doc.GState({ opacity: 1 })) } catch { /* Deno : ignoré */ }
  }
  return doc
}

/* ════════════════════════════════════════════════════════════════════════════
   MODÈLE « CABINET CLARIFIÉ » — même famille visuelle que « cabinet » (grille
   monospace pré-imprimée, calendrier journalier) mais rubriques REGROUPÉES du
   bulletin clarifié (arrêté du 25/02/2016), bloc d'identification en trois
   colonnes, compteurs de congés en lignes de texte, coordonnées bancaires dans
   le cadre « NET A PAYER ». Géométrie relevée sur un bulletin de logiciel de
   paie (12/10/2026), en points A4. Décrit par `layoutCabinetClarifie` : la MÊME
   description sert au PDF (`traceOps`) et à l'aperçu écran (BulletinPreviewEncadre).
   ════════════════════════════════════════════════════════════════════════════ */

const CC = {
  G_X0: 18.6, G_X1: 442.4, G_TOP: 258, G_HEAD: 282.3, G_BOTTOM: 589,
  C_LBL: 261, C_BASE: 309.5, C_TAUX: 349, C_SAL: 397.7,
  // Filets des décimales (« pré-imprimé ») : base, taux, part salarié, employeur
  R_BASE: 299, R_TAUX: 334.5, R_SAL: 383.2, R_PAT: 427.9,
  BODY_Y0: 289.4, PITCH: 7.9, FS: 7.2,
  K_X0: 445.5, K_X1: 570.5, K_J: 464.8, K_T: 489, K_I: 511.4,
}
const CC_INTITULES = {
  'Complémentaire Tranche 1': 'RETRAITE COMPLEMENTAIRE ET CEG TRANCHE 1',
  'Complémentaire Tranche 2': 'RETRAITE COMPLEMENTAIRE ET CEG TRANCHE 2',
  'Complémentaire CET': "CONTRIBUTION D'EQUILIBRE TECHNIQUE",
  'Complémentaire Incapacité Invalidité Décès': 'PREVOYANCE INCAPACITE INVALIDITE DECES',
  'Complémentaire Santé': 'COMPLEMENTAIRE SANTE OBLIGATOIRE',
  'ACCIDENT DU TRAVAIL-MALADIES PROFESSIONNELLES': 'ACCIDENTS DU TRAVAIL-MALADIES PROFESSIONNELLES',
  "AUTRES CONTRIBUTIONS DUES PAR L'EMPLOYEUR": "AUTRES CHARGES DUES PAR L'EMPLOYEUR",
  "CSG déductible de l'impôt sur le revenu": "CSG DEDUCTIBLE DE L'IMPOT SUR LE REVENU",
  "CSG/CRDS non déductible de l'impôt sur le revenu": "CSG/CRDS NON DEDUCTIBLES DE L'IMPOT SUR LE REVENU",
  'EXONERATIONS, ECRETEMENTS ET ALLEGEMENTS DE COTISATIONS': 'EXONERATIONS ET ALLEGEMENTS DE COTISATIONS',
  // Lignes d'exonération salariale : abrégées pour tenir dans la colonne (54 car.).
  'Réduction salariale heures supplémentaires, heures complémentaires': 'REDUCTION SALARIALE HEURES SUP. ET COMPL.',
  'Exonération de cotisations salariales apprenti': 'EXONERATION COTISATIONS SALARIALES APPRENTI',
}


/**
 * Fond bleuté du modèle « cabinet clarifié » : dégradé vertical très clair et
 * nuées irrégulières, comme le papier pré-imprimé des logiciels de paie. Motif
 * DÉTERMINISTE propre à chaque bulletin (graine = SIRET + salarié + période) :
 * même bulletin → même fond, deux bulletins → deux fonds différents. Décoratif
 * seulement (aucune valeur d'authentification). Formes OPAQUES très claires,
 * tracées sous tout le reste : le serveur (Deno) n'applique pas la transparence.
 */
function fondBleute(graine) {
  let h = 2166136261
  for (const c of String(graine)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  let a = h || 1
  const alea = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const W = 595.28, H = 841.89
  const ops = []
  // k = 0 : bleu soutenu (texte noir toujours lisible) ; k = 1 : presque blanc.
  const teinte = (k) => [Math.round(228 + 22 * k), Math.round(237 + 15 * k), Math.round(249 + 6 * k)]
  // Dégradé : 42 bandes horizontales, plus soutenu en haut, plus clair en bas.
  const bandes = 42
  for (let i = 0; i < bandes; i++) {
    const k = 0.55 + 0.4 * (i / (bandes - 1))
    ops.push({ k: 'rect', x: 0, y: (H / bandes) * i, w: W, h: H / bandes + 0.6, fill: teinte(k), stroke: null })
  }
  // Tache « floue » : 3 ellipses concentriques, du bord (plus clair) au cœur —
  // bords fondus sans transparence.
  const tache = (cx, cy, rx, ry, k) => {
    ;[[1, 0.22], [0.78, 0.1], [0.55, 0]].forEach(([e, dk]) => {
      ops.push({ k: 'el', cx, cy, rx: rx * e, ry: ry * e, fill: teinte(Math.min(1, k + dk)) })
    })
  }
  // Nuées : grandes taches soutenues, taches moyennes, puis éclaircies par-dessus.
  for (let i = 0; i < 80; i++) tache(alea() * W, alea() * H, 26 + alea() * 72, 16 + alea() * 48, alea() * 0.35)
  for (let i = 0; i < 70; i++) tache(alea() * W, alea() * H, 12 + alea() * 40, 8 + alea() * 28, 0.3 + alea() * 0.3)
  for (let i = 0; i < 120; i++) tache(alea() * W, alea() * H, 8 + alea() * 30, 5 + alea() * 20, 0.68 + alea() * 0.3)
  return ops
}

export function layoutCabinetClarifie(data, employerInfo, employeeInfo, month, year) {
  const d = data || {}
  const emp = employerInfo || {}
  const sal = employeeInfo || {}
  const ops = fondBleute([emp.siret, sal.matricule, sal.numSecu, sal.nom, sal.prenom, year, month].join('|'))
  const texts = []
  const line = (x1, y1, x2, y2, lw = 0.5, col = [0, 0, 0]) => ops.push({ k: 'line', x1, y1, x2, y2, lw, col })
  const box = (x, y, w, h, lw = 0.5) => ops.push({ k: 'rect', x, y, w, h, fill: null, stroke: [0, 0, 0], lw })
  const tx = (s, x, y, size, opts = {}) => {
    const t = s == null ? '' : String(s)
    if (t.trim()) texts.push({ k: 'tx', s: t, x, y, size, st: opts.st || 'n', al: opts.al || 'l', col: [0, 0, 0], ...(opts.mono ? { f: 'mono' } : {}) })
  }
  const mono = (s, x, y, size, opts = {}) => tx(s, x, y, size, { ...opts, mono: true })
  const sans = (s, x, y, size, opts = {}) => tx(s, x, y, size, opts)
  const caps = (s) => encCaps(s).replace(/\s+/g, ' ').trim()
  const clipM = (s, maxW, size) => {
    const t = String(s || '')
    const n = Math.max(1, Math.floor(maxW / (size * 0.6)))
    return t.length <= n ? t : t.slice(0, n)
  }
  const fr2 = (v) => (Math.round((parseFloat(v) || 0) * 100) / 100).toFixed(2).replace('.', ',')
  const MOIS = ['JANVIER', 'FEVRIER', 'MARS', 'AVRIL', 'MAI', 'JUIN', 'JUILLET', 'AOUT', 'SEPTEMBRE', 'OCTOBRE', 'NOVEMBRE', 'DECEMBRE']
  const dLongue = (ddmmyyyy) => { const [j, m, a] = String(ddmmyyyy).split('/'); return `${j} ${MOIS[parseInt(m, 10) - 1] || ''} ${a}` }
  const dEspaces = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]} ${m[2]} ${m[1]}` : '' }
  // Nombre « pré-imprimé » : partie entière à gauche du filet, décimales à droite,
  // signe négatif SUFFIXÉ — comme sur l'original.
  const nb = (v, xRule, y, size, dec = 2, keepZero = false, st = 'n') => {
    const n = parseFloat(v)
    if (!Number.isFinite(n) || (!keepZero && Math.abs(n) < 0.0005)) return
    const [ent, frac] = Math.abs(n).toFixed(dec).split('.')
    mono(ent, xRule - 0.7, y, size, { al: 'r', st })
    mono(frac + (n < 0 && Math.abs(n) >= 0.005 ? '-' : ''), xRule + 0.7, y, size, { st })
  }

  // ── Période ───────────────────────────────────────────────────────────────
  const mm = String(month + 1).padStart(2, '0')
  const dernier = new Date(year, month + 1, 0).getDate()
  const periodStart = d.proration?.periodeDebut || `01/${mm}/${year}`
  const periodEnd = d.proration?.periodeFin || `${dernier}/${mm}/${year}`
  const datePaie = datePaiementDe(d, month, year, periodEnd)

  // ── En-tête : employeur, titre, références ────────────────────────────────
  ops.push({ k: 'rr', x: 66.5, y: 45, w: 207, h: 59.6, r: 4, fill: null, lw: 0.5 })
  const raison = caps(emp.raisonSociale || emp.nom)
  mono(clipM(raison, 190, 8.4), 75, 59, 8.4)
  mono(clipM(caps(emp.adresse), 190, 8.4), 75, 75.5, 8.4)
  mono(clipM(caps([emp.codePostal, emp.ville].filter(Boolean).join(' ')), 190, 8.4), 75, 91.5, 8.4)

  sans('BULLETIN DE PAIE', 309.5, 26.5, 17, { st: 'b' })
  const refs = [
    ['NO DE SALARIE', sal.matricule || ''],
    ["PERIODE D'EMPLOI", dLongue(periodStart), 'DU'],
    ['', dLongue(periodEnd), 'AU'],
    ['DATE DE PAIEMENT', dLongue(datePaie)],
    ['NO DE SECURITE SOCIALE', String(sal.numSecu || '').replace(/\s/g, '')],
  ]
  refs.forEach(([lib, val, du], i) => {
    const y = 52.5 + i * 11.2
    if (lib) sans(lib, 309.5, y, 5.6)
    if (du) sans(du, 381, y, 5.6, { al: 'r' })
    sans(':', 385, y, 5.6)
    mono(clipM(val, 160, 7.6), 401, y, 7.6)
  })

  sans('N° SIRET', 23.6, 136, 5.6)
  mono(String(emp.siret || '').replace(/\s/g, ''), 93, 136, 7.6)
  sans('N° APE', 184.5, 136, 5.6)
  mono(String(emp.codeAPE || emp.ape || '').toUpperCase(), 217.5, 136, 7.6)
  sans('CONVENTION', 23.6, 147.5, 5.6)
  sans('COLLECTIVE:', 23.6, 154.5, 5.6)
  // Convention collective (R.3243-1 3°) : intitulé + IDCC JAMAIS tronqué, sur les
  // deux lignes libres (x 93 → 345), corps réduit si besoin ; à défaut, la
  // référence au Code du travail.
  const conv = conventionApplicable(emp)
  const parLigne = (t) => Math.floor((345 - 93) / (t * 0.6))
  // Coupure par MOTS sur 2 lignes ; « (IDCC xxxx) » reste un bloc insécable.
  const enLignes = (mots, n) => mots.reduce((ls, m) => {
    const der = ls[ls.length - 1]
    if (der && (der + ' ' + m).length <= n) ls[ls.length - 1] = der + ' ' + m
    else ls.push(m)
    return ls
  }, [])
  let tailleCcn = 7.6
  let lignesCcn
  if (!conv) lignesCcn = ['AUCUNE (CODE DU TRAVAIL)']
  else if (!conv.name) lignesCcn = [`IDCC N°${conv.idcc}`]
  else {
    const mots = caps(conv.name).split(' ').filter(Boolean)
    const idccMot = `(IDCC ${conv.idcc})`
    lignesCcn = enLignes([...mots, idccMot], parLigne(tailleCcn))
    while (lignesCcn.length > 2 && tailleCcn > 5) {
      tailleCcn = Math.round((tailleCcn - 0.2) * 10) / 10
      lignesCcn = enLignes([...mots, idccMot], parLigne(tailleCcn))
    }
    if (lignesCcn.length > 2) {
      // Intitulé hors gabarit même au plus petit corps : 2e ligne raccourcie à un
      // mot entier, terminée par « . » puis l'IDCC (jamais tronqué).
      const n = parLigne(tailleCcn)
      const l1 = enLignes(mots, n)[0]
      const reste = mots.slice(l1.split(' ').length)
      let l2 = ''
      for (const m of reste) { if ((l2 ? l2 + ' ' + m : m).length + 2 + idccMot.length > n) break; l2 = l2 ? l2 + ' ' + m : m }
      lignesCcn = [l1, `${l2.replace(/[\s,;:.]+$/, '')}. ${idccMot}`.trim()]
    }
  }
  lignesCcn.forEach((l, k) => mono(l, 93, 148 + k * 7, tailleCcn))

  const civilNom = caps([sal.nom, sal.prenom].filter(Boolean).join(' '))
  mono(clipM(civilNom, 215, 8.4), 350, 151.4, 8.4, { st: 'b' })
  mono(clipM(caps(sal.adresse), 215, 8.4), 350, 172, 8.4, { st: 'b' })
  mono(clipM(caps([sal.codePostal, sal.ville].filter(Boolean).join(' ')), 215, 8.4), 350, 192.5, 8.4, { st: 'b' })

  // ── Bloc d'identification (3 colonnes) ────────────────────────────────────
  box(18.6, 221, 550, 30.5)
  line(256.6, 221, 256.6, 251.5); line(428.8, 221, 428.8, 251.5)
  const classif = [caps(sal.statut), sal.niveau ? `NIVEAU ${caps(sal.niveau)}` : '', sal.echelon ? `ECHELON ${caps(sal.echelon)}` : ''].filter(Boolean).join(' ')
  ;[
    ['AFFECTATION', caps(sal.affectation || sal.service || emp.raisonSociale || emp.nom)],
    ['EMPLOI', caps(sal.emploi)],
    ['COEFFICIENT', caps(sal.coefficient)],
    ['CLASSIFICATION', classif],
  ].forEach(([lib, val], i) => {
    const y = 226.5 + i * 6.9
    mono(lib, 24.9, y, 6.6)
    mono(clipM(`:${val}`, 156, 6.6), 97.6, y, 6.6)
  })
  const mensuel = parseFloat(d.salaireMensuelContractuel) || 0
  if (mensuel > 0) { mono('SALAIRE MENSUEL:', 261, 226.5, 6.6); mono(fr2(mensuel), 382, 226.5, 6.6, { al: 'r' }) }
  const hContrat = parseFloat(d.horaireContractuel ?? d.horaireMensuel) || 0
  const hebdo = Math.round(hContrat * 12 / 52 * 100) / 100
  const tauxH = parseFloat(d.tauxHoraire) || 0
  ;[
    ['HORAIRE', hebdo > 0 ? fr2(hebdo) : ''],
    ['TAUX HORAIRE', tauxH > 0 ? (Math.round(tauxH * 10000) / 10000).toFixed(4).replace(/0{1,2}$/, '').replace('.', ',') : ''],
    ['SAL.MENS.REF.', mensuel > 0 ? fr2(mensuel) : ''],
  ].forEach(([lib, val], i) => {
    const y = 226.5 + i * 7.6
    mono(lib, 433, y, 6.6); mono(':', 506, y, 6.6); mono(val, 558, y, 6.6, { al: 'r' })
  })

  // ── Lignes de la grille ───────────────────────────────────────────────────
  // kind : 'ligne' | 'tete' (gras) | 'total' (points de conduite) | 'note'
  const rows = []
  const libGain = (g) => {
    if (g.role === 'base') return 'SALAIRE DE BASE'
    if (g.role === 'entreeSortie') return 'ABS ENTREE / SORTIE'
    if (g.role === 'cpAbsence') return caps(g.labelCourt || g.label)
    if (g.role === 'cpIndemnite') return caps(g.label).replace(/^INDEMNITE DE CONGES PAYES/, 'IND CONGES PAYES')
    return caps(g.label)
  }
  // Taux imprimé à 3 décimales, ou 4 quand la 4e est significative : base × taux
  // imprimés retombent alors sur le montant au centime (taux horaire 12,1975…).
  const taux4 = (t) => (t == null ? t : Math.round((parseFloat(t) || 0) * 1e4) / 1e4)
  const decTaux = (t) => (t != null && Math.abs(t * 1000 - Math.round(t * 1000)) > 1e-6 ? 4 : 3)
  gainsClarifies(d).forEach((g) => {
    const t = taux4((g.role === 'cpAbsence' || g.role === 'cpIndemnite') && g.base > 0 ? Math.abs(g.amt) / g.base : g.taux)
    rows.push({ kind: 'ligne', label: libGain(g), base: g.role === 'base' ? g.heures : g.base, taux: t, sal: g.amt, dec: decTaux(t) })
  })
  rows.push({ kind: 'total', label: '*REMUNERATION BRUTE.(1)', col: 'sal', v: d.totalBrut })
  rubriquesClarifiees(d).forEach((r) => {
    const lib = CC_INTITULES[r.label] || caps(r.label)
    const t = taux4(r.taux)
    if (r.kind === 'pay') rows.push({ kind: 'ligne', label: lib, base: r.base, taux: t, sal: r.amt, dec: decTaux(t) })
    else rows.push({ kind: r.kind === 'head' ? 'tete' : 'ligne', label: lib, base: r.base, taux: t, sal: r.amt, pat: r.mpat ? -r.mpat : 0, dec: decTaux(t) })
  })
  rows.push({ kind: 'total', label: '*COTISAT.SALARIALES.(2)', col: 'sal', v: -(d.totalCotisSal || 0) })
  if ((parseFloat(d.reintegrationSante) || 0) > 0) rows.push({ kind: 'note', label: `FR.SANTE IMP.    ${fr2(d.reintegrationSante)}` })
  rows.push({ kind: 'ligne', label: 'IMPOT SUR LE REVENU PRELEVE', base: d.baseIR, taux: d.tauxIR, sal: -(d.irPreleve || 0), dec: 3, keepTaux: true })
  rows.push({ kind: 'note', label: d.irAuto === false ? 'TAUX PERSONNALISE' : 'TAUX NON PERSONNALISE' })
  rows.push({ kind: 'total', label: '*AUTRES RETENUES....(4)', col: 'sal', v: -(d.irPreleve || 0) })
  rows.push({ kind: 'total', label: '*COTISAT.PATRONALES', col: 'pat', v: d.totalCotisPat })

  // Une page garantie : interligne et corps resserrés au-delà de 37 lignes.
  const dispo = CC.G_BOTTOM - 4 - CC.BODY_Y0
  const pitch = rows.length > 1 ? Math.min(CC.PITCH, dispo / (rows.length - 1)) : CC.PITCH
  const fs = Math.max(4.6, CC.FS * pitch / CC.PITCH)
  const lblX = 23.6
  const lblMax = CC.C_LBL - lblX - 2
  rows.forEach((r, i) => {
    const y = CC.BODY_Y0 + i * pitch
    const st = r.kind === 'tete' || r.kind === 'total' ? 'b' : 'n'
    if (r.kind === 'total') {
      const xr = r.col === 'pat' ? CC.R_PAT : CC.R_SAL
      const n = Math.max(0, Math.floor((xr - 18 - lblX) / (fs * 0.6)) - r.label.length)
      mono(r.label + '.'.repeat(n), lblX, y, fs, { st })
      nb(r.v, xr, y, fs, 2, true, st)
      return
    }
    mono(clipM(r.label, lblMax, fs), lblX, y, fs, { st })
    if (r.kind === 'note') return
    nb(r.base, CC.R_BASE, y, fs, 2)
    // 4 décimales : corps réduit pour rester entre le filet et le bord de colonne.
    if (r.taux != null && (r.keepTaux || Math.abs(parseFloat(r.taux) || 0) >= 0.00005)) nb(r.taux, CC.R_TAUX, y, r.dec === 4 ? Math.min(fs, 5.4) : fs, r.dec || 3, !!r.keepTaux)
    nb(r.sal, CC.R_SAL, y, fs, 2)
    nb(r.pat, CC.R_PAT, y, fs, 2)
  })

  // ── Cadre de la grille, en-têtes, filets ──────────────────────────────────
  box(CC.G_X0, CC.G_TOP, CC.G_X1 - CC.G_X0, CC.G_BOTTOM - CC.G_TOP, 0.6)
  line(CC.G_X0, CC.G_HEAD, CC.G_X1, CC.G_HEAD)
  ;[CC.C_LBL, CC.C_BASE, CC.C_SAL].forEach((x) => line(x, CC.G_TOP, x, CC.G_BOTTOM))
  line(CC.C_TAUX, 270, CC.C_TAUX, CC.G_BOTTOM)
  line(CC.C_BASE, 270, CC.C_SAL, 270)
  sans('DESIGNATION', (CC.G_X0 + CC.C_LBL) / 2, 273.5, 5.6, { al: 'c' })
  sans('NOMBRE', (CC.C_LBL + CC.C_BASE) / 2, 266.5, 5.6, { al: 'c' })
  sans('OU BASE', (CC.C_LBL + CC.C_BASE) / 2, 278.5, 5.6, { al: 'c' })
  sans('PART EMPLOYE', (CC.C_BASE + CC.C_SAL) / 2, 266, 5.6, { al: 'c' })
  sans('TAUX OU %', (CC.C_BASE + CC.C_TAUX) / 2, 278.5, 5.6, { al: 'c' })
  sans('MONTANT', (CC.C_TAUX + CC.C_SAL) / 2, 278.5, 5.6, { al: 'c' })
  sans('EMPLOYEUR', (CC.C_SAL + CC.G_X1) / 2, 266, 5.6, { al: 'c' })
  sans('MONTANT', (CC.C_SAL + CC.G_X1) / 2, 278.5, 5.6, { al: 'c' })
  const gris = [165, 165, 165]
  ;[CC.R_BASE, CC.R_TAUX, CC.R_SAL, CC.R_PAT].forEach((x) => line(x, CC.G_HEAD, x, CC.G_BOTTOM, 0.25, gris))

  // ── Calendrier : codes d'incident par jour ────────────────────────────────
  box(CC.K_X0, 262, CC.K_X1 - CC.K_X0, CC.G_BOTTOM - 262)
  sans('INFORMATIONS JOURNALIERES', (CC.K_X0 + CC.K_X1) / 2, 268, 4.8, { al: 'c' })
  line(CC.K_X0, 270.5, CC.K_X1, 270.5)
  mono(`DU ${periodStart.replace(/\//g, '-')}  AU ${periodEnd.replace(/\//g, '-')}`, (CC.K_X0 + CC.K_X1) / 2, 276.3, 5, { al: 'c' })
  line(CC.K_X0, 278.5, CC.K_X1, 278.5)
  sans('JOUR', (CC.K_X0 + CC.K_J) / 2, 282.6, 4.4, { al: 'c' })
  sans('TRAVAIL', (CC.K_J + CC.K_T) / 2, 282.6, 4.4, { al: 'c' })
  sans('INCIDENT', (CC.K_T + CC.K_I) / 2, 282.6, 4.4, { al: 'c' })
  sans('INCIDENT', (CC.K_I + CC.K_X1) / 2, 282.6, 4.4, { al: 'c' })
  line(CC.K_X0, 284.5, CC.K_X1, 284.5)
  ;[CC.K_J, CC.K_T, CC.K_I].forEach((x) => line(x, 278.5, x, CC.G_BOTTOM, 0.3))
  const cal = calendrierMois(year, month, hContrat, {
    presenceStart: d.proration?.presenceStart, presenceEnd: d.proration?.presenceEnd,
    congesDebut: d.congesPayes?.debut, congesFin: d.congesPayes?.fin, absences: d.absencesLignes,
  })
  cal.forEach((j, i) => {
    const y = 291 + i * 7.6
    mono(`${j.lettre} ${String(j.jour).padStart(2, '0')}`, CC.K_X0 + 3, y, 5.8)
    if (j.incident) mono(j.incident, CC.K_T + 3, y, 5.8)
  })

  // ── Net social / net à payer avant impôt ──────────────────────────────────
  box(23.6, 593.6, 418.8, 36.4)
  line(23.6, 611.8, 442.4, 611.8); line(404, 593.6, 404, 630)
  mono('MONTANT NET SOCIAL', 28, 604, 7.6, { st: 'b' })
  nb(d.netSocial, CC.R_PAT, 604, 7.6, 2, true, 'b')
  mono('NET A PAYER AVANT IMPOT SUR LE REVENU', 28, 622.5, 7.6, { st: 'b' })
  nb(d.netAvantIR, CC.R_PAT, 622.5, 7.6, 2, true, 'b')

  // ── Revenus du mois / depuis janvier ──────────────────────────────────────
  const cum = d.cumuls || {}
  box(23.6, 637, 247.9, 91)
  line(23.6, 644.5, 271.5, 644.5); line(144, 637, 144, 728); line(199, 637, 199, 728)
  mono('REVENUS EN EUROS', 26.5, 642.3, 6.4)
  sans('DU MOIS', 171.5, 642.3, 5.6, { al: 'c' })
  sans(`DEPUIS 01 ${year}`, 235.2, 642.3, 5.6, { al: 'c' })
  const revenus = [
    ['PRELEVEMENT A LA SOURCE', d.irPreleve, cum.irPreleve, 651],
    ['TOTAL VERSE EMPLOYEUR', d.totalVerseEmployeur, cum.totalVerse, 658.6],
  ]
  if ((parseFloat(d.montantNetHSExonere) || 0) > 0 || (parseFloat(cum.hsExonere) || 0) > 0) revenus.push(['HS/HC EXONEREES', d.montantNetHSExonere, cum.hsExonere, 666.2])
  revenus.push(['NET FISCAL', d.baseIR, cum.netImposable, 688])
  revenus.forEach(([lib, m, c, y]) => { mono(lib, 26.5, y, 6.4); nb(m, 188, y, 6.4, 2, true); nb(c, 260.5, y, 6.4, 2, true) })
  mono('-'.repeat(27), 26.5, 694.5, 6.4)

  // ── Net à payer + règlement ───────────────────────────────────────────────
  box(276.5, 637, 165.9, 91)
  sans('NET A PAYER', 281, 643.5, 5.6)
  sans('1-2-4', 281, 650.5, 5.2)
  nb(d.netAPayer, 427.9, 647, 8, 2, true, 'b')
  line(276.5, 654.5, 442.4, 654.5)
  const modeBrut = String(d.modePaiement || sal.modePaiement || emp.modePaiement || 'Virement')
  const mode = caps(modeBrut.split(/\s+/)[0])
  mono('EN EUROS', 281, 661.5, 6.6, { st: 'b' })
  mono(mode, 335, 661.5, 6.6, { st: 'b' })
  line(276.5, 664.8, 442.4, 664.8, 0.3)
  const bancaire = []
  bancaire.push(caps([sal.nom, sal.prenom].filter(Boolean).join(' ')))
  if (/^VIREMENT/.test(mode)) {
    if (sal.banque) {
      // Nom de banque long : coupé sur un espace, sur deux lignes.
      const b = caps(sal.banque)
      const n = 35
      if (b.length <= n) bancaire.push(b)
      else { const c = b.lastIndexOf(' ', n); const i = c > 0 ? c : n; bancaire.push(b.slice(0, i).trimEnd(), b.slice(i).trim()) }
    }
    if (sal.bic) bancaire.push(`BIC : ${String(sal.bic).replace(/\s/g, '').toUpperCase()}`)
    const iban = String(sal.iban || '').replace(/\s/g, '').toUpperCase()
    if (iban) {
      const groupes = iban.match(/.{1,4}/g) || []
      bancaire.push(`IBAN: ${groupes.slice(0, 5).join(' ')}`)
      if (groupes.length > 5) bancaire.push(`      ${groupes.slice(5).join(' ')}`)
    }
  }
  // Bornées au cadre (bord droit 442,4) : 35 caractères Courier 6,6 au plus.
  bancaire.forEach((l, i) => mono(clipM(l, 442.4 - 300 - 2, 6.6), 300, 672 + i * 8.2, 6.6, { st: i === 0 ? 'b' : 'n' }))

  // ── Entrée, ancienneté, congés ────────────────────────────────────────────
  const lv = d.leave || {}
  box(23.6, 733.6, 247.9, 68.4)
  const prisN1 = Math.min(parseFloat(lv.cpN1Acquis) || 0, parseFloat(lv.cumulCongesPris) || 0)
  ;[
    `DATE ENTREE ${dEspaces(sal.dateEntree)} DATE ANCIEN ${dEspaces(sal.dateAnciennete || sal.dateEntree)}`,
    `SOLDE CP EN COUR ${fr2(lv.cpNSolde)} DROITS CP ECOULE ${fr2(lv.cpN1Acquis)}`,
    `PRIS CP ECOULE   ${fr2(prisN1)} SOLDE CP ECOULE  ${fr2(lv.cpN1Solde)}`,
  ].forEach((l, i) => mono(clipM(l, 240, 6.4), 27, 742 + i * 7.6, 6.4))

  // ── Commentaires (libellé vertical) ───────────────────────────────────────
  box(276.5, 733.6, 165.9, 68.4)
  line(285.5, 733.6, 285.5, 802)
  'COMMENTAIRES'.split('').forEach((c, i) => sans(c, 281, 740 + i * 5.1, 4.4, { al: 'c' }))

  // ── Légende des codes du calendrier ───────────────────────────────────────
  box(CC.K_X0, 733.6, CC.K_X1 - CC.K_X0, 68.4)
  const codes = { JF: 'JF JOUR FERIE', CP: 'CP CONGES PAYES', AB: 'AB ABSENCE NON REMUNEREE' }
  Object.keys(codes).filter((c) => cal.some((j) => j.incident === c)).forEach((c, i) => mono(codes[c], CC.K_X0 + 3, 741 + i * 7.4, 5.8))

  sans("Nous vous recommandons de conserver votre bulletin de paie, sans limitation de durée - Pour davantage d'informations, voir la rubrique dédiée au bulletin de paie sur www.service-public.fr.",
    297.6, 812, 4.8, { al: 'c' })

  return { w: 595.28, h: 841.89, ops: ops.concat(texts) }
}

/** Trace `layoutCabinetClarifie` avec jsPDF (unité : point). */
function buildCabinetClarifieDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options = {}) {
  const doc = new JsPDF('p', 'pt', 'a4')
  patchTradText(doc)
  traceOps(doc, layoutCabinetClarifie(data, employerInfo, employeeInfo, month, year).ops)
  if (options.watermark) {
    try { doc.setGState(new doc.GState({ opacity: 0.13 })) } catch { /* Deno : ignoré */ }
    doc.setTextColor(180, 40, 40); doc.setFont('helvetica', 'bold'); doc.setFontSize(30)
    for (let k = 0; k < 5; k++) doc.text('SPÉCIMEN — NON PAYÉ', 62.36, 170.08 + k * 147.4, { angle: 33 })
    try { doc.setGState(new doc.GState({ opacity: 1 })) } catch { /* Deno : ignoré */ }
  }
  return doc
}
