#!/usr/bin/env node

const commander = require('commander')
const packageInfo = require('./package.json')
const colors = require('colors')
const inquirer = require('inquirer')
const keypath = require('nasa-keypath')
const mkdirp = require('mkdirp')
const sanitizeFilename = require('sanitize-filename')
const util = require('util')
const path = require('path')
const fs = require('fs')
const { readFile } = require('fs/promises')
const os = require('os')
const userAgent = util.format('Humblebundle-Ebook-Downloader/%s', packageInfo.version)
const playwright = require('playwright')
const PMap = require('p-map')
const { default: PQueue } = require('p-queue')
const hasha = require('hasha')
const Got = require('got')
const { promisify } = require('util')
const stream = require('stream')
const pipeline = promisify(stream.pipeline)

const SUPPORTED_FORMATS = ['epub', 'mobi', 'pdf', 'pdf_hd', 'cbz']
const ALLOWED_FORMATS = SUPPORTED_FORMATS.concat(['all']).sort()

commander
  .version(packageInfo.version)
  .option('-d, --download-folder <downloader_folder>', 'Download folder', 'download')
  .option('-l, --download-limit <download_limit>', 'Parallel download limit', 1)
  .option('-f, --format <format>', util.format('What format to download the ebook in (%s)', ALLOWED_FORMATS.join(', ')), 'epub')
  .option('--auth-token <auth-token>', 'Optional: If you want to run headless, you can specify your authentication cookie from your browser (_simpleauth_sess)')
  .option('-a, --all', 'Download all bundles')
  .option('--debug', 'Enable debug logging', false)
  .parse()

const options = commander.opts()

if (ALLOWED_FORMATS.indexOf(options.format) === -1) {
  console.error(colors.red('Invalid format selected.'))
  commander.help()
}

const configPath = path.resolve(os.homedir(), '.humblebundle_ebook_downloader.json')

console.log(colors.green('Starting...'))

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

function getRequestHeaders (session) {
  return {
    Accept: 'application/json',
    'Accept-Charset': 'utf-8',
    'User-Agent': userAgent,
    Cookie: '_simpleauth_sess=' + session + ';'
  }
}

async function validateSession (config) {
  console.log('Validating session...')

  let session = config.session

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

  const { statusCode } = await Got.get('https://www.humblebundle.com/api/v1/user/order?ajax=true', {
    headers: getRequestHeaders(session)
  })

  if (statusCode === 200) {
    return session
  }

  if (statusCode === 401 && !commander.authToken) {
    return null
  }

  throw new Error(util.format('Could not validate session, unknown error, status code:', statusCode))
}

function saveConfig (config, callback) {
  fs.writeFile(configPath, JSON.stringify(config, null, 4), 'utf8', callback)
}

function debug () {
  if (commander.debug) {
    console.log(colors.yellow('[DEBUG] ' + util.format.apply(this, arguments)))
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

  saveConfig({
    session: sessionCookie.value,
    expires: new Date(sessionCookie.expires * 1000)
  }, (error) => {
    if (error) {
      throw error
    }

    return sessionCookie.value
  })
}

async function fetchOrders (session) {
  console.log('Fetching bundles...')

  const response = await Got.get('https://www.humblebundle.com/api/v1/user/order?ajax=true', {
    headers: getRequestHeaders(session)
  })

  if (response.statusCode !== 200) {
    throw new Error(util.format('Could not fetch orders, unknown error, status code:', response.statusCode))
  }

  const allBundles = JSON.parse(response.body)

  const total = allBundles.length
  let done = 0
  const orders = []

  for (const { gamekey } of allBundles) {
    const bundle = await Got.get(util.format('https://www.humblebundle.com/api/v1/order/%s?ajax=true', gamekey), {
      headers: getRequestHeaders(session)
    })

    if (bundle.statusCode !== 200) {
      throw new Error(util.format('Could not fetch orders, unknown error, status code:', bundle.statusCode))
    }

    done += 1
    console.log('Fetched bundle information... (%s/%s)', colors.yellow(done), colors.yellow(total))
    orders.push(JSON.parse(bundle.body))
  }

  const filteredOrders = orders.filter((order) => {
    return flatten(keypath.get(order, 'subproducts.[].downloads.[].platform')).indexOf('ebook') !== -1
  })

  return filteredOrders
}

function getWindowHeight () {
  const windowSize = process.stdout.getWindowSize()
  return windowSize[windowSize.length - 1]
}

async function displayOrders (orders) {
  const choices = []

  for (const order of orders) {
    choices.push(order.product.human_name)
  }

  choices.sort((a, b) => {
    return a.localeCompare(b)
  })

  process.stdout.write('\x1Bc') // Clear console

  const answers = await inquirer.prompt({
    type: 'checkbox',
    name: 'bundle',
    message: 'Select bundles to download',
    choices,
    pageSize: getWindowHeight() - 2
  })

  return orders.filter((item) => {
    return answers.bundle.indexOf(item.product.human_name) !== -1
  })
}

function flatten (list) {
  return list.reduce((a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), [])
}

function normalizeFormat (format) {
  switch (format.toLowerCase()) {
    case '.cbz':
      return 'cbz'
    case 'pdf (hq)':
    case 'pdf (hd)':
      return 'pdf_hd'
    case 'download':
      return 'pdf'
    default:
      return format.toLowerCase()
  }
}

function getExtension (format) {
  switch (format.toLowerCase()) {
    case 'pdf_hd':
      return ' (hd).pdf'
    default:
      return util.format('.%s', format)
  }
}

async function checkSignatureMatch (filePath, download) {
  if (fs.existsSync(filePath)) {
    const algorithm = download.sha1 ? 'sha1' : 'md5'
    const hashToVerify = download[algorithm]
    const hash = await hasha.fromFile(filePath, { algorithm })
    return hash === hashToVerify
  }
  return false
}

let totalDownloads = 0
let doneDownloads = 0

const downloadQueue = new PQueue({ concurrency: options.downloadLimit })
const downloadPromises = []

async function processBundles (bundles) {
  if (!bundles.length) {
    console.log(colors.green('No bundles selected, exiting'))
    return
  }

  const downloads = []

  for (const bundle of bundles) {
    const bundleName = bundle.product.human_name
    const bundleDownloads = []
    const bundleFormats = []

    for (const subproduct of bundle.subproducts) {
      const filteredDownloads = subproduct.downloads.filter((download) => {
        return download.platform === 'ebook'
      })

      const downloadStructs = flatten(keypath.get(filteredDownloads, '[].download_struct'))
      const filteredDownloadStructs = downloadStructs.filter((download) => {
        if (!download.name || !download.url) {
          return false
        }

        const normalizedFormat = normalizeFormat(download.name)

        if (bundleFormats.indexOf(normalizedFormat) === -1 && SUPPORTED_FORMATS.indexOf(normalizedFormat) !== -1) {
          bundleFormats.push(normalizedFormat)
        }

        return options.format === 'all' || normalizedFormat === options.format
      })

      for (const filteredDownload of filteredDownloadStructs) {
        bundleDownloads.push({
          bundle: bundleName,
          download: filteredDownload,
          name: subproduct.human_name
        })
      }
    }

    if (!bundleDownloads.length) {
      console.log(colors.red('No downloads found matching the right format (%s) for bundle (%s), available formats: (%s)'), options.format, bundleName, bundleFormats.sort().join(', '))
      continue
    }

    for (const download of bundleDownloads) {
      downloads.push(download)
    }
  }

  if (!downloads.length) {
    console.log(colors.red('No downloads found matching the right format (%s), exiting'), options.format)
  }

  console.log(`Downloading ${bundles.length} bundles`)

  totalDownloads = downloads.length

  return PMap(downloads, downloadEbook, { concurrency: 5 })
}

// function downloadBundlesOLD (bundles) {
//   if (!bundles.length) {
//     console.log(colors.green('No bundles selected, exiting'))
//     return
//   }

//   async.each(downloads, (download) => {
//     limiter.submit(() => {
//       console.log('Downloading %s - %s (%s) (%s)... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
//       downloadBook(download.bundle, download.name, download.download, (error, skipped) => {
//         if (error) {
//           throw error
//         }

//         if (skipped) {
//           console.log('Skipped downloading of %s - %s (%s) (%s) - already exists... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
//         }
//       })
//     })
//   }, (error) => {
//     if (error) {
//       throw error
//     }

//     console.log(colors.green('Done'))
//   })
// }

async function downloadEbook (download) {
  const downloadPath = path.resolve(
    options.downloadFolder,
    sanitizeFilename(download.bundle)
  )
  await mkdirp(downloadPath)

  const fileName = `${download.name.trim()}${getExtension(
    normalizeFormat(download.download.name)
  )}`

  const filePath = path.resolve(downloadPath, sanitizeFilename(fileName))
  const fileExists = await checkSignatureMatch(filePath, download.download)

  if (!fileExists) {
    downloadPromises.push(
      downloadQueue.add(() => doDownload(filePath, download))
    )
  } else {
    console.log(
      'Skipped downloading of %s (%s) (%s) - already exists... (%s/%s)',
      download.name,
      normalizeFormat(download.download.name),
      download.download.human_size,
      colors.yellow(++doneDownloads),
      colors.yellow(totalDownloads)
    )
  }
}

async function doDownload (filePath, download) {
  console.log(
    'Downloading %s - %s (%s) (%s)...',
    download.bundle,
    download.name,
    normalizeFormat(download.download.name),
    download.download.human_size
  )

  await new Promise((resolve, reject) => {
    const downloadStream = Got.stream(download.download.url.web)
    const writer = fs.createWriteStream(filePath)
    pipeline(downloadStream, writer)
      .then(() => resolve())
      .catch((error) => console.error(`Something went wrong. ${error.message}`))
  })

  console.log(
    'Downloaded %s - %s (%s) (%s)... (%s/%s)',
    download.bundle,
    download.name,
    normalizeFormat(download.download.name),
    download.download.human_size,
    colors.yellow(++doneDownloads),
    colors.yellow(totalDownloads)
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

    const orders = await fetchOrders(session)
    const bundles = await displayOrders(orders)
    await processBundles(bundles)
    await Promise.all(downloadPromises)
    console.log(colors.green('Done!'))
    process.exit(1)
  } catch (error) {
    console.error(colors.red('An error occured, exiting.'))
    console.error(error)
    process.exit(1)
  }
}

main()

// flow.then(loadConfig)
// flow.then(validateSession)
// flow.when((session) => !session, authenticate)
// flow.then(fetchOrders)
// flow.when(!options.all, displayOrders)
// flow.when(options.all, sortBundles)
// flow.then(downloadBundles)

// flow.catch((error) => {
//   console.error(colors.red('An error occured, exiting.'))
//   console.error(error)
//   process.exit(1)
// })
