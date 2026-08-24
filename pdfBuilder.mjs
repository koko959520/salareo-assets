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
 * Constructeur du bulletin PDF. Reçoit le constructeur jsPDF (`JsPDF`) pour rester
 * isomorphe. `options.watermark = true` appose un filigrane SPÉCIMEN (aperçu non payé).
 * @returns instance jsPDF (non sauvegardée)
 */
export function buildPdfDoc(JsPDF, data, employerInfo, employeeInfo, month, year, template = 'classic', options = {}) {
  // Le modèle « traditionnel » ne partage AUCUNE géométrie avec les trois autres
  // (monospace, 5 colonnes propres, rubriques en capitales, pagination à en-tête
  // répété). Il est donc rendu par une fonction dédiée plutôt qu'en ajoutant une
  // palette ici : aucune régression possible sur classic/modern/minimalist, et le
  // moteur « une page garantie » ci-dessous ne s'applique pas à lui.
  if (template === 'traditionnel') {
    return buildTraditionnelDoc(JsPDF, data, employerInfo, employeeInfo, month, year, options)
  }

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
    return siret || '000 000 000 00000'
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
    return 'DROIT COMMUN - 0000'
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
  doc.text(employerInfo.nom || 'Nom Entreprise', margin, y + 3)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  setColor(BLACK)
  doc.text(employerInfo.adresse || 'Adresse', margin, y + 7)
  doc.text(`${employerInfo.codePostal || '75000'} ${employerInfo.ville || 'VILLE'}`, margin, y + 10)
  setColor(GRAY)
  doc.text(`SIRET : ${formatSIRET(employerInfo.siret)}`, margin, y + 14)
  doc.text(`Code APE : ${employerInfo.codeAPE || '0000Z'}`, margin, y + 17)
  doc.text(`Convention : ${formatConvText(employerInfo.convention, colW1 - 18)}`, margin, y + 20)

  // Col 2: Employee
  doc.setFontSize(8)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text(`${employeeInfo.prenom} ${employeeInfo.nom}`, margin + colW1 + 5, y + 3)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(6.5)
  setColor(BLACK)
  // Adresse salariale (obligatoire sur le bulletin)
  doc.text(employeeInfo.adresse || '-', margin + colW1 + 5, y + 7)
  doc.text(`${employeeInfo.codePostal || ''} ${employeeInfo.ville || ''}`.trim() || '-', margin + colW1 + 5, y + 10)
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
  doc.text(`Emploi : ${employeeInfo.emploi || 'Employé'}`, col3X, y + 9)
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
    let catCount = 0, prevCat = null
    data.cotisations.forEach(c => { if (c.category !== prevCat) { catCount++; prevCat = c.category } })
    const hasAlleg = data.exoCotisSalHS > 0 || data.reductionGenerale > 0
    const allegDataRows = (data.reductionGenerale > 0 ? 1 : 0) + (data.exoCotisSalHS > 0 ? 2 : 0)
    const rowUnits = 1 + hsCount + primeCount + 1 + data.cotisations.length + allegDataRows + 1 + 1
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
        doc.text(safe, rx + (indent ? 5 : 2), baseline)
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

  // TOTAL BRUT
  drawPdfRow([
    'Rémunération brute  (1)', '-', '-',
    formatMontant(data.totalBrut),
    '-'
  ], { bold: true, bgColor: LIGHT_GRAY, textColor: PRIMARY })

  // Cotisations
  let currentCat = null
  data.cotisations.forEach((c) => {
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
      c.name,
      formatMontant(c.base),
      c.tauxSal > 0 ? formatTaux(c.tauxSal) : '-',
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
    doc.text('Allègements de cotisations', tableX + 2, y + CAT_H * 0.68)
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
    'Total cotisations salariales  (4)', '-', '-',
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
  doc.text('Dont évolution de la rémunération liée à la suppression des cotisations chômage et maladie : 0,00 €', tableX + 2, y + DISC_H * 0.7)
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
  leftY += 8

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
    { label: 'Allègement de cotisations employeur :', val: `${formatMontant(data.totalAllegements)} €`, color: SUCCESS_GREEN },
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
  textRight('RTT', rightX + gridW - 2, rightY + 2.4)
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
  textRight(formatMontant(leave.rttAcquis), rightX + gridW - 2, rightY + 2.4)
  rightY += 3.5

  // Pris row
  drawRect(rightX, rightY, gridW, 3.5)
  doc.text('Pris (cumul)', rightX + 2, rightY + 2.4)
  const cpN1Pris = Math.min(leave.cpN1Acquis, leave.cumulCongesPris)
  const cpNPris = leave.cumulCongesPris > leave.cpN1Acquis ? leave.cumulCongesPris - leave.cpN1Acquis : 0
  const rttPrisVal = leave.cumulRttPris
  
  textRight(formatMontant(cpN1Pris), rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight(formatMontant(cpNPris), rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  textRight(formatMontant(rttPrisVal), rightX + gridW - 2, rightY + 2.4)
  rightY += 3.5

  // Solde row
  fillRect(rightX, rightY, gridW, 3.5, LIGHT_GRAY)
  drawRect(rightX, rightY, gridW, 3.5)
  doc.setFont('helvetica', 'bold')
  setColor(PRIMARY)
  doc.text('Solde disponible', rightX + 2, rightY + 2.4)
  textRight(formatMontant(leave.cpN1Solde), rightX + cW0 + cW1 - 2, rightY + 2.4)
  textRight(formatMontant(leave.cpNSolde), rightX + cW0 + cW1 + cW2 - 2, rightY + 2.4)
  textRight(formatMontant(leave.rttSolde), rightX + gridW - 2, rightY + 2.4)
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
  doc.text(periodEnd, margin + 24, footerY + 9)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(5.2)
  setColor(GRAY)
  doc.text('Formule : Rémunération brute (1) + Exonération (2) - Retenues salariales (4) - Impôt source (5)', margin, footerY + 14)

  // Numérotation de page
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
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

  item({ label: 'Total Brut', salAmt: data.totalBrut, bold: true })
  gap()

  let cat = null
  ;(data.cotisations || []).forEach((c) => {
    if (c.category !== cat) { cat = c.category; rows.push({ kind: 'cat', label: c.category }) }
    item({
      label: c.name, sub: true,
      base: c.base, taux: c.tauxSal,
      salAmt: c.partSal > 0 ? -c.partSal : 0,
      patAmt: c.partPat > 0 ? -c.partPat : 0,
    })
  })

  if ((data.totalAllegements || 0) > 0) {
    gap()
    item({ label: 'ALLEGEMENT DE COTISATIONS :', cap: true, patAmt: data.totalAllegements })
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
    const ccn = emp.conventionName || emp.convention || ''
    if (ccn) doc.text(clip(`CCN  ${ccn}`, 100), T.X0, 46.5)

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
    doc.text(`DATE DE PAIE : ${periodEnd}`, 140.0, 92.0)

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

    // Mention réglementaire (bandeau bleu clair)
    fill(T.X0, T.NET_Y + 1.8, T.X1 - T.X0, 3.6, TRAD_SKY)
    stroke(T.X0, T.NET_Y + 1.8, T.X1 - T.X0, 3.6)
    ;[T.C1, T.C2, T.C3, T.C4].forEach((x) => rule(x, T.NET_Y + 1.8, x, T.NET_Y + 5.4))
    sans(4.6, 'bold'); ink(TRAD_NAVY)
    doc.text("Dont évolution de la rémunération liée à la suppression des cotisations chômage et maladie", T.X0 + 1, T.NET_Y + 4.3)

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
      // Mode de règlement, sous le bloc — comme sur le bulletin de référence.
      const mode = data.modePaiement || emp.modePaiement || 'VIREMENT'
      mono(7); ink([0, 0, 0])
      doc.text(`MODE DE REGLEMENT : ${String(mode).toUpperCase()}`, T.X0, T.IR_TOP + irH * 2 + 3.4)
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
      'BRUT CONGES PAYES', 'Allègements cotisations\nemployeur', 'Total versé par l\'employeur']
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
      const mois = [data.totalBrut, data.totalCotisSal, data.totalCotisPat, data.baseIR, null, data.totalAllegements, data.totalVerseEmployeur]
      const cumul = [cum.brut, cum.cotisSal, cum.cotisPat, cum.netImposable, null, cum.allegements, cum.totalVerse]
      mois.forEach((v, i) => { if (v != null) right(fmtTrad(v, true), xs[i + 1] - 1.5, r1y + 3.7) })
      cumul.forEach((v, i) => { if (v != null) right(fmtTrad(v, true), xs[i + 1] - 1.5, r2y + 3.7) })
    }

    // Pied de page
    sans(5.6); ink(TRAD_BLUE)
    center('Pour la définition des termes employés, se reporter au site internet www.service-public.fr rubrique cotisations sociales', 105, T.FOOT_Y)
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

/** SIRET « XXX XXX XXX XXXXX » — copie locale (celle de buildPdfDoc lui est interne). */
function formatSiretTrad(siret) {
  const d = String(siret || '').replace(/\s/g, '')
  return d.length === 14 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}` : (siret || '')
}
