import { createWorker } from 'tesseract.js'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const MISSING_FIELD = 'N/A'
const BARE_FIVE_DIGIT_CODE = /(?<![\d()])(\d{5})(?![\d()])/g
const CLAIMANT_LABEL = /^(?:patient(?:['’]s)?|claimant|member|insured|policyholder|subscriber(?!\s+(?:id|number)\b)|customer|beneficiary|covered\s+(?:person|member)|name\s+of\s+(?:patient|claimant|member))(?:\s+full)?(?:\s+name)?\s*(?:[:#=]\s*|[-–—]\s*|$)(.*)$/i
const PROVIDER_LABEL = /^(?:billing\s+provider|rendering\s+provider|servicing\s+provider|service\s+provider|performing\s+provider|healthcare\s+provider|medical\s+provider|treating\s+provider|attending\s+physician|treating\s+physician|pay[- ]to\s+provider|provider\s*\/\s*facility|billing\s+entity|billing\s+organization|billed\s+by|payee|vendor|supplier|name\s+of\s+(?:provider|facility)|physician|doctor|hospital|clinic|medical\s+center|facility|provider)(?:\s+name)?\s*(?:[:#=]\s*|[-–—]\s*|$)(.*)$/i
const DIAGNOSIS_LABEL = /^(?:diagnosis\s*(?:[/&]|\band\b)\s*treatment|treatment\s*(?:[/&]|\band\b)\s*diagnosis|diagnosis\s+(?:summary|details|description)|treatment\s+(?:summary|details|provided)|medical\s+necessity|medical\s+(?:condition|diagnosis)|clinical\s+impression|chief\s+complaint|presenting\s+complaint|primary\s+diagnosis|nature\s+of\s+illness|condition\s+treated|service\s+description|description\s+of\s+(?:services?|treatment)|services?\s+rendered|procedure\s+performed|diagnosis|treatment|procedure|assessment|reason\s+for\s+(?:visit|treatment|admission))\s*(?:[:#=]\s*|[-–—]\s*|\s+|$)(.*)$/i
const POLICY_LABEL = /^(?:account(?:\s+(?:no\.?|number))?|policy(?:\s+(?:no\.?|number))?|member\s+(?:id|number)|insurance\s+(?:id|number)|subscriber\s+(?:id|number)|health\s+plan\s+(?:id|number))\s*(?:#+\s*[:#=-]?\s*|[:#=]\s*|[-–—]\s*|\s+|$)(.*)$/i
const SECTION_LABEL = /^date\s+of\s+service\s*[:#=-]?\s*$/i
const FIELD_LABELS = [CLAIMANT_LABEL, PROVIDER_LABEL, DIAGNOSIS_LABEL, POLICY_LABEL, SECTION_LABEL]

const MAX_PDF_DIMENSION = 1800

function normalizeFiveDigitCodes(value) {
  return String(value || '').replace(BARE_FIVE_DIGIT_CODE, '($1)')
}

export function parseClaimFields(text) {
  const lines = text
    .split(/\r?\n/)
    .map((textLine) => textLine.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const fieldFromLine = (pattern) => {
    for (let index = 0; index < lines.length; index += 1) {
      const matched = lines[index].match(pattern)
      if (!matched) continue
      const value = matched[1]?.trim() || ''
      if (value) return value
      const nextLine = lines[index + 1]
      if (nextLine && !FIELD_LABELS.some((label) => label.test(nextLine))) return nextLine
    }
    return ''
  }

  const claimant = fieldFromLine(CLAIMANT_LABEL)
  const provider = fieldFromLine(PROVIDER_LABEL)
  const policyNumber = fieldFromLine(POLICY_LABEL)
  const diagnosis = normalizeFiveDigitCodes(fieldFromLine(DIAGNOSIS_LABEL)
    || (() => {
      const startIndex = lines.findIndex((line) => /\bDATE\s+OF\s+SERVICE\b/i.test(line))
      if (startIndex < 0) return ''
      const startLine = lines[startIndex]
      const startMarker = /\bDATE\s+OF\s+SERVICE\b\s*[:#-]?\s*/i
      const firstContent = startLine.replace(startMarker, '').trim()
      const sectionLines = firstContent && !/\btablets?\b/i.test(firstContent) ? [firstContent] : []
      for (const line of lines.slice(startIndex + 1)) {
        if (/^INSURANCE\b/i.test(line)) break
        if (!/\btablets?\b/i.test(line)) sectionLines.push(line)
      }
      return sectionLines.join(' ').trim()
    })())
  const amountLine = lines.find((candidate) => /^(?:total(?:\s+(?:amount|claim|bill|charges?))?|amount(?:\s+(?:claimed|due|billed))?|claim(?:ed)?\s+amount|bill\s+amount)\s*[:#-]?\s*/i.test(candidate))
  const amountMatch = amountLine?.match(/(?:USD\s*|[$₹€£]\s*)?([\d,]+(?:\.\d{1,2})?)/i)
  const amount = amountMatch ? amountMatch[1].replace(/,/g, '') : ''
  const diagnosisCodeMatches = lines.flatMap((candidate) => [...candidate.matchAll(/(?:ICD(?:\s*[- ]?\s*10(?:\s*[- ]?\s*CM)?)?(?:\s+code)?|diagnosis\s+code)\s*[:#-]?\s*([A-Z0-9.]{3,10})/gi)])
  const procedureCodeMatches = lines.flatMap((candidate) => [...candidate.matchAll(/(CPT|HCPCS|procedure\s+code)(?:\s+code)?\s*[:#-]?\s*([A-Z0-9]{1,6})/gi)])
  const diagnosisCodes = [...new Set(diagnosisCodeMatches.map((match) => match[1].toUpperCase()))]
  const procedureCodes = [...new Set(procedureCodeMatches.map((match) => match[2].toUpperCase()))]
  const cptCodes = [...new Set(procedureCodeMatches.filter((match) => match[1].toUpperCase() === 'CPT').map((match) => match[2].toUpperCase()))]
  const hcpcsCodes = [...new Set(procedureCodeMatches.filter((match) => match[1].toUpperCase() === 'HCPCS').map((match) => match[2].toUpperCase()))]
  const procedureAmounts = []
  const seenProcedureAmounts = new Set()
  const addProcedureAmounts = (line, matches) => {
    for (const match of matches) {
      const code = match[1].toUpperCase()
      const before = line.slice(Math.max(0, match.index - 32), match.index)
      const after = line.slice(match.index + match[0].length, match.index + match[0].length + 32)
      const pricePattern = /(?:USD\s*|[$₹€£]\s*)([\d,]+(?:\.\d{1,2})?)/gi
      const nearbyPrices = [
        ...[...before.matchAll(pricePattern)].map((price) => ({ distance: before.length - price.index - price[0].length, value: price[1] })),
        ...[...after.matchAll(pricePattern)].map((price) => ({ distance: price.index, value: price[1] })),
      ]
      if (!nearbyPrices.length) continue
      const amount = Number(nearbyPrices.sort((left, right) => left.distance - right.distance)[0].value.replace(/,/g, ''))
      const key = `${code}:${amount}`
      if (!seenProcedureAmounts.has(key)) {
        seenProcedureAmounts.add(key)
        procedureAmounts.push({ code, amount })
      }
    }
  }
  for (const line of lines) {
    const labeledCptMatches = [...line.matchAll(/\bCPT(?:\s+code)?\s*[:#-]?\s*(\d{5}|\d{4}[FTU])\b/gi)]
    const bracketedCptMatches = [...line.matchAll(/[({]\s*(\d{5}|\d{4}[FTU])\s*[)}]/gi)]
    addProcedureAmounts(line, [...labeledCptMatches, ...bracketedCptMatches])
  }
  const diagnosisCodeValue = diagnosisCodes[0] || ''
  const procedureCodeValue = procedureCodes[0] || ''
  const diagnosisCode = diagnosisCodeValue || MISSING_FIELD
  const procedureCode = procedureCodeValue || MISSING_FIELD
  const procedureSystemLabel = procedureCodeMatches[0]?.[1].toUpperCase() || ''

  return {
    claimant: claimant || MISSING_FIELD,
    provider: provider || MISSING_FIELD,
    policyNumber: policyNumber || MISSING_FIELD,
    diagnosis: diagnosis || MISSING_FIELD,
    amount: amount || MISSING_FIELD,
    diagnosisCode,
    diagnosisCodes,
    procedureCode,
    procedureCodes,
    cptCodes,
    hcpcsCodes,
    procedureAmounts,
    codeChecks: {
      diagnosis: diagnosisCodeValue
        ? { system: 'ICD-10-CM', value: diagnosisCodeValue, formatValid: /^[A-Z]\d[A-Z0-9](?:\.?[A-Z0-9]{1,4})?$/.test(diagnosisCodeValue) }
        : null,
      procedure: procedureCodeValue
        ? {
            system: procedureSystemLabel === 'HCPCS'
              || (procedureSystemLabel === 'PROCEDURE CODE' && /^[A-Z]/.test(procedureCode))
              ? 'HCPCS'
              : 'CPT',
            value: procedureCodeValue,
            formatValid: /^(?:\d{5}|[A-Z]\d{4})$/.test(procedureCodeValue),
          }
        : null,
    },
  }
}

async function recognizeImage(worker, image, onProgress, fileName, pageLabel = '') {
  const { data } = await worker.recognize(image)
  onProgress?.({ fileName, pageLabel, progress: 1, stage: 'Reading text' })
  return data.text || ''
}

async function scanPdf(file, getWorker, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const pageTexts = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const textContent = await page.getTextContent()
    const embeddedLines = []
    let currentLine = ''
    let currentY
    for (const item of textContent.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const itemY = item.transform?.[5]
      if (currentLine && itemY !== undefined && currentY !== undefined && Math.abs(itemY - currentY) > 3) {
        embeddedLines.push(currentLine)
        currentLine = ''
      }
      currentLine = `${currentLine} ${item.str}`.trim()
      currentY = itemY
      if (item.hasEOL) {
        embeddedLines.push(currentLine)
        currentLine = ''
        currentY = undefined
      }
    }
    if (currentLine) embeddedLines.push(currentLine)
    const embeddedText = embeddedLines.join('\n').trim()

    if (embeddedText) {
      pageTexts.push(embeddedText)
      onProgress?.({ fileName: file.name, pageLabel: `Page ${pageNumber} of ${pdf.numPages}`, progress: pageNumber / pdf.numPages, stage: 'Reading PDF text' })
      continue
    }

    const unscaledViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(1.5, MAX_PDF_DIMENSION / Math.max(unscaledViewport.width, unscaledViewport.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not prepare a page for document scanning.')

    await page.render({ canvas, canvasContext: context, viewport }).promise
    const worker = await getWorker()
    pageTexts.push(await recognizeImage(worker, canvas, onProgress, file.name, `Page ${pageNumber} of ${pdf.numPages}`))
    canvas.width = 0
    canvas.height = 0
  }

  return pageTexts.join('\n')
}

export async function scanClaimDocuments(files, onProgress) {
  const documents = Array.from(files || [])
  if (!documents.length) {
    throw new Error('Choose a JPEG, PNG, or PDF document before scanning.')
  }

  let worker
  let activeFileName = ''
  const getWorker = async () => {
    if (!worker) {
      onProgress?.({ fileName: '', progress: 0, stage: 'Loading English OCR model' })
      worker = await createWorker('eng', undefined, {
        logger: ({ status, progress }) => {
          onProgress?.({ fileName: activeFileName, progress, stage: status })
        },
      })
    }
    return worker
  }

  const textByFile = []
  try {
    for (let index = 0; index < documents.length; index += 1) {
      const file = documents[index]
      activeFileName = file.name
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(file.name)
      if (!isPdf && !isImage) {
        throw new Error(`${file.name} is not a supported image or PDF.`)
      }

      onProgress?.({ fileName: file.name, progress: 0, stage: `Scanning document ${index + 1} of ${documents.length}` })
      const text = isPdf
        ? await scanPdf(file, getWorker, onProgress)
        : await recognizeImage(await getWorker(), file, onProgress, file.name)
      textByFile.push(text)
    }
  } finally {
    if (worker) await worker.terminate()
  }

  return parseClaimFields(textByFile.join('\n'))
}
