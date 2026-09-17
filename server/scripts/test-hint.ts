import { readFileSync } from 'node:fs'
import { parseSchedulePdf } from '../src/services/pdf-parser.js'

const r = await parseSchedulePdf(new Uint8Array(readFileSync('../张特奥(2026-2027-1)课表.pdf')))
console.log('hint:', r.semesterNameHint)
console.log('cells:', r.cells.length)
