#!/usr/bin/env node

const async = require('async')
const commander = require('commander')
const packageInfo = require('./package.json')
const request = require('request')
const Breeze = require('breeze')
const Bottleneck = require('bottleneck')
const colors = require('colors')
const crypto = require('crypto')
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
const flow = Breeze()
const limiter = new Bottleneck({ // Limit concurrent downloads
  maxConcurrent: options.downloadLimit
})

console.log(colors.green('Starting...'))

async function loadConfig () {
  try {
    return readFile(configPath, { encoding: 'utf8' })
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

function validateSession (config) {
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

  request.get({
    url: 'https://www.humblebundle.com/api/v1/user/order?ajax=true',
    headers: getRequestHeaders(session),
    json: true
  }, (error, response) => {
    if (error) {
      throw error
    }

    if (response.statusCode === 200) {
      return session
    }

    if (response.statusCode === 401 && !commander.authToken) {
      return null
    }

    throw new Error(util.format('Could not validate session, unknown error, status code:', response.statusCode))
  })
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

function fetchOrders (session) {
  console.log('Fetching bundles...')

  request.get({
    url: 'https://www.humblebundle.com/api/v1/user/order?ajax=true',
    headers: getRequestHeaders(session),
    json: true
  }, (error, response) => {
    if (error) {
      throw error
    }

    if (response.statusCode !== 200) {
      throw new Error(util.format('Could not fetch orders, unknown error, status code:', response.statusCode))
    }

    const total = response.body.length
    let done = 0

    const orderInfoLimiter = new Bottleneck({
      maxConcurrent: 5,
      minTime: 500
    })

    async.concat(response.body, (item) => {
      orderInfoLimiter.submit(() => {
        request.get({
          url: util.format('https://www.humblebundle.com/api/v1/order/%s?ajax=true', item.gamekey),
          headers: getRequestHeaders(session),
          json: true
        }, (error, response) => {
          if (error) {
            throw error
          }

          if (response.statusCode !== 200) {
            throw new Error(util.format('Could not fetch orders, unknown error, status code:', response.statusCode))
          }

          console.log('Fetched bundle information... (%s/%s)', colors.yellow(++done), colors.yellow(total))
          return response.body
        })
      })
    }, (error, orders) => {
      if (error) {
        throw error
      }

      const filteredOrders = orders.filter((order) => {
        return flatten(keypath.get(order, 'subproducts.[].downloads.[].platform')).indexOf('ebook') !== -1
      })

      return filteredOrders
    })
  })
}

function getWindowHeight () {
  const windowSize = process.stdout.getWindowSize()
  return windowSize[windowSize.length - 1]
}

function displayOrders (orders) {
  const choices = []

  for (const order of orders) {
    choices.push(order.product.human_name)
  }

  choices.sort((a, b) => {
    return a.localeCompare(b)
  })

  process.stdout.write('\x1Bc') // Clear console

  inquirer.prompt({
    type: 'checkbox',
    name: 'bundle',
    message: 'Select bundles to download',
    choices,
    pageSize: getWindowHeight() - 2
  }).then((answers) => {
    return orders.filter((item) => {
      return answers.bundle.indexOf(item.product.human_name) !== -1
    })
  })
}

function sortBundles (bundles) {
  return bundles.sort((a, b) => {
    return a.product.human_name.localeCompare(b.product.human_name)
  })
}

function flatten (list) {
  return list.reduce((a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), [])
}

function ensureFolderCreated (folder, callback) {
  fs.access(folder, (error) => {
    if (error && error.code !== 'ENOENT') {
      return callback(error)
    }

    mkdirp(folder).then(made => {
      callback()
    }).catch(error => {
      callback(error)
    })
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

function checkSignatureMatch (filePath, download, callback) {
  fs.access(filePath, (error) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return callback()
      }

      return callback(error)
    }

    const hashType = download.sha1 ? 'sha1' : 'md5'
    const hashToVerify = download[hashType]

    const hash = crypto.createHash(hashType)
    hash.setEncoding('hex')

    const stream = fs.createReadStream(filePath)

    stream.on('error', (error) => {
      return callback(error)
    })

    stream.on('end', () => {
      hash.end()

      return callback(null, hash.read() === hashToVerify)
    })

    stream.pipe(hash)
  })
}

function downloadBook (bundle, name, download, callback) {
  const downloadPath = path.resolve(options.downloadFolder, sanitizeFilename(bundle))

  ensureFolderCreated(downloadPath, (error) => {
    if (error) {
      return callback(error)
    }

    const fileName = util.format('%s%s', name.trim(), getExtension(normalizeFormat(download.name)))
    const filePath = path.resolve(downloadPath, sanitizeFilename(fileName))

    checkSignatureMatch(filePath, download, (error, matches) => {
      if (error) {
        return callback(error)
      }

      if (matches) {
        return callback(null, true)
      }

      const file = fs.createWriteStream(filePath)

      file.on('finish', () => {
        file.close(() => {
          callback()
        })
      })

      request.get({
        url: download.url.web
      }).on('error', (error) => {
        callback(error)
      }).pipe(file)
    })
  })
}

function downloadBundles (bundles) {
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

  async.each(downloads, (download) => {
    limiter.submit(() => {
      console.log('Downloading %s - %s (%s) (%s)... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
      downloadBook(download.bundle, download.name, download.download, (error, skipped) => {
        if (error) {
          throw error
        }

        if (skipped) {
          console.log('Skipped downloading of %s - %s (%s) (%s) - already exists... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
        }
      })
    })
  }, (error) => {
    if (error) {
      throw error
    }

    console.log(colors.green('Done'))
  })
}

async function main () {
  try {
    const config = await loadConfig()
    console.log('🚀 ~ file: index.js ~ line 436 ~ main ~ config', config)
    let session
    session = await validateSession(config)
    if (!session) {
      session = await authenticate()
    }
    const orders = await fetchOrders(session)
    const download = await displayOrders(orders)
    await downloadBundles(download)
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
