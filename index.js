#!/usr/bin/env node

import { existsSync, createWriteStream } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { homedir } from 'os'
import { resolve } from 'path'
import { pipeline } from 'stream/promises'
import util from 'util'

import chalk from 'chalk'
import commander from 'commander'
import got from 'got'
import hasha from 'hasha'
import inquirer from 'inquirer'
import keypath from 'nasa-keypath'
import playwright from 'playwright'
import PMap from 'p-map'
import PQueue from 'p-queue'
import sanitizeFilename from 'sanitize-filename'

const SUPPORTED_FORMATS = ['epub', 'mobi', 'prc', 'pdf', 'pdf_hd', 'cbz', 'video']
const ALLOWED_FORMATS = SUPPORTED_FORMATS.concat(['all']).sort()

// Node cannot yet import json in a module, so we need to do this to require our package.json
const require = createRequire(import.meta.url)
const { version } = require('./package.json')

commander
  .version(version)
  .option('-d, --download-folder <downloader_folder>', 'Download folder', 'download')
  .option('-l, --download-limit <download_limit>', 'Parallel download limit', 1)
  .option('-f, --formats <formats>', util.format('Comma-separated list of formats to download (%s)', ALLOWED_FORMATS.join(', ')), 'pdf')
  .option('--filter <filter>', 'Only display bundles with this text in the title')
  .option('--auth-token <auth-token>', 'Optional: If you want to run headless, you can specify your authentication cookie from your browser (_simpleauth_sess)')
  .option('-k, --keys <keys>', 'Comma-separated list of specific purchases to download')
  .option('-s, --sort <sort>', 'Order to sort bundles in menu (name, date)', 'name')
  .option('-a, --all', 'Download all bundles')
  .option('--debug', 'Enable debug logging', false)
  .parse()

const options = commander.opts()

let totalDownloads = 0
let doneDownloads = 0
const downloadQueue = new PQueue({ concurrency: options.downloadLimit })
const downloadPromises = []

const formatsToDownload = options.formats.split(',')

formatsToDownload.forEach(format => {
  if (ALLOWED_FORMATS.indexOf(format) === -1) {
    console.error(chalk.red('Invalid format selected.'))
    commander.help()
  }
})

const configPath = resolve(homedir(), '.humblebundle_ebook_downloader.json')

console.log(chalk.green('Starting...'))

main()

async function loadConfig () {
  try {
    const file = await readFile(configPath, { encoding: 'ascii' })
    return JSON.parse(file)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}
    }

    throw error
  }
}

const userAgent = util.format('Humblebundle-Ebook-Downloader/%s', version)

const getRequestHeaders = (session) => {
  return {
    Accept: 'application/json',
    'Accept-Charset': 'utf-8',
    'User-Agent': userAgent,
    Cookie: '_simpleauth_sess=' + session + ';'
  }
}

async function validateSession (config) {
  console.log('Validating session...')

  let { session } = config

  if (!commander.authToken) {
    if (!config.session || !config.expires) {
      return null
    }

    if (config.expires < new Date()) {
      return null
    }
  } else {
    session = util.format('"%s"', commander.authToken.replace(/^"|"$/g, ''))
  }

  const { statusCode } = await got.get('https://www.humblebundle.com/api/v1/user/order?ajax=true', {
    headers: getRequestHeaders(session),
    throwHttpErrors: false
  })

  if (statusCode === 200) {
    return session
  }

  if (statusCode === 401 && !commander.authToken) {
    return null
  }

  throw new Error(util.format('Could not validate session, unknown error, status code:', statusCode))
}

async function saveConfig (config, callback) {
  await writeFile(configPath, JSON.stringify(config, null, 4))
}

function debug () {
  if (commander.debug) {
    console.log(chalk.yellow('[DEBUG] ' + util.format.apply(this, arguments)))
  }
}

async function authenticate () {
  console.log('Authenticating...')

  const browser = await playwright.chromium.launch({
    headless: false
  })
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('https://www.humblebundle.com/login?goto=%2Fhome%2Flibrary')

  // We disable the default 30s timeout as 2FA would take longer than that
  await page.waitForURL('https://www.humblebundle.com/home/library', { timeout: 0 })

  const cookies = await context.cookies()
  const [sessionCookie] = cookies.filter(cookie => cookie.name === '_simpleauth_sess')

  await browser.close()

  await saveConfig({
    session: sessionCookie.value,
    expires: new Date(sessionCookie.expires * 1000)
  })

  return sessionCookie.value
}

async function fetchAndFilterKeys (session) {
  // Fetch the list of gamekeys
  const keysResponse = await got.get('https://www.humblebundle.com/api/v1/user/order?ajax=true', {
    headers: getRequestHeaders(session),
    throwHttpErrors: false
  })

  if (keysResponse.statusCode !== 200) {
    throw new Error(util.format('Could not fetch orders, unknown error, status code:', keysResponse.statusCode))
  }

  // Extract and return all keys into an array
  return JSON
    .parse(keysResponse.body)
    .map(bundle => bundle.gamekey)
}

function filterKeys (keys) {
  // If no keys to filter by were specified on the command line then just return all keys
  if (!options.keys) {
    return keys
  }

  const specifiedKeys = options.keys.split(',')

  // Check that each specified key is in the full array of keys, and throw an error if not
  specifiedKeys.forEach(key => {
    if (!keys.includes(key)) {
      throw new Error(util.format('Invalid key %s', key))
    }
  })

  return specifiedKeys
}

async function fetchAndFilterOrders (keys, session) {
  const fetchedOrders = []

  // We use the https://www.humblebundle.com/api/v1/orders endpoint which allows us to fetch multiple bundles in one go.
  // This is the endpoint used by https://www.humblebundle.com/home/purchases

  // We cut the keys array into 40-key chunks as this is the max number of keys we can fetch from the endpoint
  const chunkSize = 40
  const chunkedKeys = chunkArray(keys, chunkSize)

  for (const [index, chunk] of chunkedKeys.entries()) {
    console.log(util.format('Fetching bundle details... (%s-%s/%s)',
      chalk.yellow(index * chunkSize + 1),
      chalk.yellow(Math.min((index + 1) * chunkSize, keys.length)),
      chalk.yellow(keys.length)
    ))

    // The endpoint takes keys in the format `gamekeys=...&gamekeys=...&gamekeys=...` so assemble a string of this
    const gamekeysString = chunk
      .map(gamekey => `gamekeys=${gamekey}`)
      .join('&')

    const chunkResponse = await got.get((util.format('https://www.humblebundle.com/api/v1/orders?%s', gamekeysString)), {
      headers: getRequestHeaders(session)
    })

    // The endpoint returns an object where each value is an order, so we pull these values into an array
    const parsedOrders = JSON.parse(chunkResponse.body)
    const ordersArray = Object.values(parsedOrders)

    // Use the spread operator push the contents of ordersArray into ordersToReturn individually
    fetchedOrders.push(...ordersArray)
  }

  return fetchedOrders
}

function filterOrders (orders) {
  return orders
    // If a filter option was specified than filter out any orders which don't have that text in its name
    .filter(order => {
      const lowercaseBundleName = order.product.human_name.toLowerCase()
      return (
        !options.filter || lowercaseBundleName.includes(options.filter.toLowerCase())
      )
    })
    // Filter out any orders which don't have an ebook section
    .filter(order => {
      return keypath
        .get(order, 'subproducts.[].downloads.[].platform')
        .flat()
        .indexOf('ebook') !== -1
    })
    // Sort the bundle by the specified option
    .sort((a, b) => sortBundles(a, b, options.sort))
}

function sortBundles (a, b, sortOrder) {
  switch (sortOrder) {
    case 'name':
      return a.product.human_name.localeCompare(b.product.human_name)
    case 'date':
      // We use the created date, which is stored as a string so we can use localeCompare()
      // We compare b with a to so that we sort in reverse order (ie. latest bundle first)
      return b.created.localeCompare(a.created)
  }
}

function chunkArray (array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_element, index) =>
    array.slice(index * size, index * size + size)
  )
}

function getWindowHeight () {
  const windowSize = process.stdout.getWindowSize()
  return windowSize[windowSize.length - 1]
}

async function displayOrders (orders) {
  const choices = orders
    .map(order => order.product.human_name)

  process.stdout.write('\x1Bc') // Clear console

  const answers = await inquirer.prompt({
    type: 'checkbox',
    name: 'bundle',
    message: 'Select bundles to download',
    choices,
    pageSize: getWindowHeight() - 2
  })

  return orders.filter(item => {
    return answers.bundle.indexOf(item.product.human_name) !== -1
  })
}

function normalizeFormat (format) {
  switch (format.toLowerCase()) {
    case '.cbz':
      return 'cbz'
    case 'pdf (hq)':
    case 'pdf (hd)':
      return 'pdf_hd'
    case 'download':
      return 'download'
    case 'supplement':
      return 'supplement'
    default:
      return format.toLowerCase()
  }
}

function adjustFormat (format, isVideo) {
  return isVideo ? `video ${format}` : format
}

function getExtension (format) {
  switch (format.toLowerCase()) {
    case 'pdf_hd':
      return ' (hd).pdf'
    case 'supplement':
      return '.supplement.zip'
    case 'download':
      return '.download.zip'
    default:
      return util.format('.%s', format)
  }
}

async function checkSignatureMatch (filePath, download) {
  if (existsSync(filePath)) {
    const algorithm = download.sha1 ? 'sha1' : 'md5'
    const hashToVerify = download[algorithm]
    const hash = await hasha.fromFile(filePath, { algorithm })
    return hash === hashToVerify
  }
  return false
}

async function processBundles (bundles) {
  if (!bundles.length) {
    console.log(chalk.green('No bundles selected, exiting'))
    return
  }

  const downloads = []

  for (const bundle of bundles) {
    const bundleName = bundle.product.human_name
    const bundleDownloads = []
    const bundleFormats = []

    for (const subproduct of bundle.subproducts) {
      const filteredDownloads = subproduct.downloads.filter(download => requiredPlatform(download.platform))

      const downloadStructs = keypath
        .get(filteredDownloads, '[].download_struct')
        .flat()

      const filteredDownloadStructs = downloadStructs.filter(download => {
        if (!download.name || !download.url) {
          return false
        }

        // Determine if this is a video so we know if it should be downloaded
        const isVideo = identifyVideo(download, subproduct)
        const normalizedFormat = isVideo ? 'video' : normalizeFormat(download.name)

        if (bundleFormats.indexOf(normalizedFormat) === -1 && SUPPORTED_FORMATS.indexOf(normalizedFormat) !== -1) {
          bundleFormats.push(normalizedFormat)
        }

        return formatsToDownload.includes('all') || formatsToDownload.includes(normalizedFormat)
      })

      for (const filteredDownload of filteredDownloadStructs) {
        const isVideo = identifyVideo(filteredDownload, subproduct)
        const normalizedFormat = normalizeFormat(filteredDownload.name)
        const adjustedFormat = adjustFormat(normalizedFormat, isVideo)

        bundleDownloads.push({
          bundle: bundleName,
          download: filteredDownload,
          name: subproduct.human_name,
          adjustedFormat
        })
      }
    }

    if (!bundleDownloads.length) {
      console.log(
        chalk.red('No downloads found matching the right format%s (%s) for bundle (%s), available format%s: (%s)'),
        pluralise(formatsToDownload),
        formatsToDownload.join(', '),
        bundleName,
        pluralise(bundleFormats),
        bundleFormats.sort().join(', '))
      continue
    }

    for (const download of bundleDownloads) {
      downloads.push(download)
    }
  }

  if (!downloads.length) {
    console.log(
      chalk.red('No downloads found matching the right format%s (%s), exiting'),
      pluralise(formatsToDownload),
      formatsToDownload.join(', ')
    )
  }

  console.log(`Downloading ${bundles.length} bundles`)

  totalDownloads = downloads.length

  return PMap(downloads, downloadEbook, { concurrency: 5 })
}

function pluralise (array) {
  return array.length > 1 ? 's' : ''
}

function requiredPlatform (platform) {
  return platform === 'ebook' || 'video'
}

function identifyVideo (download, subproduct) {
  if (download.platform === 'video') {
    return true
  }

  // We class an item as a video if the format is 'download' or 'supplement', and any part of the subproduct url (split
  // by /) ends in 'video'. This catches cases where videos are in the eBook section, but have a subproduct url such as
  // https://www.packtpub.com/product/full-stack-vue-with-graphql-the-ultimate-guide-video/9781838984199
  const isDownloadOrSupplement = normalizeFormat(download.name) === 'download' || normalizeFormat(download.name) === 'supplement'

  const urlParts = subproduct.url.split('/')
  const urlIsVideo = urlParts.some(string => string.endsWith('video'))

  if (isDownloadOrSupplement && urlIsVideo) {
    return true
  }

  return false
}

async function downloadEbook (download) {
  const downloadPath = resolve(
    options.downloadFolder,
    sanitizeFilename(download.bundle)
  )
  await mkdir(downloadPath, { recursive: true })

  const name = download.name.trim()
  const extension = getExtension(normalizeFormat(download.download.name))
  const filename = `${name}${extension}`

  const filePath = resolve(downloadPath, sanitizeFilename(filename))
  const fileExists = await checkSignatureMatch(filePath, download.download)

  if (!fileExists) {
    downloadPromises.push(
      downloadQueue.add(() => doDownload(filePath, download))
    )
  } else {
    console.log(
      'Skipped downloading of %s (%s) (%s) - already exists... (%s/%s)',
      download.name,
      download.adjustedFormat,
      download.download.human_size,
      chalk.yellow(++doneDownloads),
      chalk.yellow(totalDownloads)
    )
  }
}

async function doDownload (filePath, download) {
  console.log(
    'Downloading %s - %s (%s) (%s)...',
    download.bundle,
    download.name,
    download.adjustedFormat,
    download.download.human_size
  )

  await new Promise((resolve, reject) => {
    const downloadStream = got.stream(download.download.url.web)
    const writer = createWriteStream(filePath)
    pipeline(downloadStream, writer)
      .then(() => resolve())
      .catch(error => console.error(`Something went wrong. ${error.message}`))
  })

  console.log(
    'Downloaded %s - %s (%s) (%s)... (%s/%s)',
    download.bundle,
    download.name,
    download.adjustedFormat,
    download.download.human_size,
    chalk.yellow(++doneDownloads),
    chalk.yellow(totalDownloads)
  )
}

async function main () {
  try {
    const config = await loadConfig()

    let session
    session = await validateSession(config)
    if (!session) {
      session = await authenticate()
    }

    console.log('Fetching bundles...')
    const fetchedKeys = await fetchAndFilterKeys(session)
    const filteredKeys = filterKeys(fetchedKeys)

    const fetchedOrders = await fetchAndFilterOrders(filteredKeys, session)
    const filteredOrders = filterOrders(fetchedOrders)

    const bundles = options.all
      ? filteredOrders
      : await displayOrders(filteredOrders)

    await processBundles(bundles)
    await Promise.all(downloadPromises)
    console.log(chalk.green('Done!'))
    process.exit(1)
  } catch (error) {
    console.error(chalk.red('An error occured, exiting.'))
    console.error(error)
    process.exit(1)
  }
}
