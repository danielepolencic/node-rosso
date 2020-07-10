import { Worker, isMainThread, parentPort, workerData, WorkerOptions, MessagePort } from 'worker_threads'
import { Response } from 'node-fetch'
import { Node } from 'unist'
import { resolve } from 'path'
import {
  Classifier as ClassifierClass,
  ClassifierConstructor,
  DocumentConstructor,
  DataSetConstructor,
} from 'dclassify'

const fetch = require('node-fetch')
const dclassify = require('dclassify')
const Classifier: ClassifierConstructor = dclassify.Classifier
const Document: DocumentConstructor = dclassify.Document
const DataSet: DataSetConstructor = dclassify.DataSet
const English = require('parse-english')
const pos = require('retext-pos')()
const keywords = require('retext-keywords')()
const toString = require('nlcst-to-string')

interface SheetCell {
  gs$cell: {
    row: string
    col: string
  }
  content: {
    $t: string
  }
}

interface Keyword {
  matches: { node: Node }[]
}

interface Phrase {
  matches: { nodes: Node[] }[]
}

export const MESSAGE = {
  STATUS: 'STATUS',
  ERROR: 'ERROR',
  LOG: 'LOG',
  TRAINED: 'TRAINED',
  RESULT: 'RESULT',
  PAYLOAD: 'PAYLOAD',
}

// For debug
let queueNum = 1

if (!isMainThread) {
  if (parentPort) {
    const port = parentPort
    const classifierPromise: Promise<ClassifierClass> = trainModel(workerData.sheetUrl, port).then((classifier) => {
      return new Promise((resolve) => {
        resolve(classifier)
      })
    })
    port.on('message', (message) => {
      switch (message.type) {
        case MESSAGE.PAYLOAD:
          classifierPromise.then((classifier) => {
            const newText = new Document(`Text ${queueNum++}`, tokenize(message.value))
            const result = classifier.classify(newText)
            port.postMessage({
              type: MESSAGE.RESULT,
              value: {
                payload: message.value,
                category: result.category,
                name: `${newText.id}`,
              },
            })
          })
          break

        default:
          break
      }
    })
  }
}

export function trainingWorker(sheetUrl: string): Worker {
  const worker = workerTs(__filename, {
    workerData: { sheetUrl },
  })
  return worker
}

function workerTs(file: string, options: WorkerOptions) {
  if (!options.workerData) {
    options.workerData = {}
  }
  options.workerData.__filename = file
  return new Worker(resolve(__dirname, 'classifierWorker.js'), options)
}

function trainModel(sheetUrl: string, port: MessagePort): Promise<ClassifierClass> {
  port.postMessage({ type: MESSAGE.STATUS, value: { fill: 'yellow', shape: 'ring', text: 'Fetch And Train Data...' } })
  return fetch(sheetUrl)
    .then((res: Response) => res.json())
    .then((json: any) => {
      port.postMessage({ type: MESSAGE.LOG, value: 'Data Fetched' })
      return json
    })
    .then((json: any) => {
      const entries = json.feed.entry
      const startTime = process.hrtime()
      const dataset = createDataset(entries)
      port.postMessage({ type: MESSAGE.LOG, value: `Dataset created in ${process.hrtime(startTime)[0]} seconds` })

      const options = {
        applyInverse: true,
      }
      const classifier: ClassifierClass = new Classifier(options)

      return new Promise((resolve) => {
        const startTime = process.hrtime()
        classifier.train(dataset)
        port.postMessage({
          type: MESSAGE.LOG,
          value: `Model trained in ${process.hrtime(startTime)[0]} seconds`,
        })
        port.postMessage({ type: MESSAGE.STATUS, value: { fill: 'green', shape: 'dot', text: 'Classifier Trained' } })
        port.postMessage({ type: MESSAGE.TRAINED, value: '' })

        resolve(classifier)
      })
    })
    .catch((err: Error) => {
      port.postMessage({ type: MESSAGE.ERROR, value: `${err.message}.` })
      port.postMessage({ type: MESSAGE.ERROR, value: 'Did you publish your goolge sheet?' })
      port.postMessage({ type: MESSAGE.STATUS, value: { fill: 'red', shape: 'ring', text: err.message } })
    })
}

function createDataset(entries: SheetCell[]) {
  const texts = entries
    .filter((it) => it.gs$cell.col === '1')
    .reduce((obj, it) => {
      return {
        ...obj,
        [`row-${it.gs$cell.row}`]: it.content.$t,
      }
    }, {} as Record<string, string>)

  const categories = entries
    .filter((it) => it.gs$cell.col === '2')
    .reduce((obj, it) => {
      return {
        ...obj,
        [`row-${it.gs$cell.row}`]: it.content.$t,
      }
    }, {} as Record<string, string>)

  const rows = Object.keys(texts).map((row) => {
    return {
      row,
      text: texts[row],
      category: categories[row] || '',
    }
  })

  const data = rows.map((it) => {
    return {
      category: it.category,
      doc: new Document(it.row, tokenize(it.text)),
    }
  })

  const categoriesSet = rows.map((it) => it.category).filter((it, i, arr) => arr.indexOf(it) === i)

  const dataset = new DataSet()
  categoriesSet.forEach((category) => {
    dataset.add(
      category,
      data.filter((it) => it.category === category).map((it) => it.doc),
    )
  })

  return dataset
}

export function tokenize(str: string): string[] {
  const tree = new English().parse(str)
  const file = { data: { keywords: [] as Keyword[], keyphrases: [] as Phrase[] } }
  pos(tree)
  keywords(tree, file)
  const allKeywords: string[] = file.data.keywords.map((keyword) => {
    return toString(keyword.matches[0].node)
  })

  const allKeywordPhrases: string[] = file.data.keyphrases.map((phrase) => {
    return phrase.matches[0].nodes.map(toString).join('')
  })
  return [...allKeywords, ...allKeywordPhrases]
}