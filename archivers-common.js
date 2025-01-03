
import * as fs from 'node:fs'
import * as n_path from 'node:path'
import {ChromeDevToolsProtocol, initChrome} from 'jlc-cdp'

export const logInfo = console.log
export const log = (...args) => {
  const d = new Date()
  const t = {
    hours: d.getHours().toString().padStart(2,'0'),
    minutes: d.getMinutes().toString().padStart(2,'0'),
    seconds: d.getSeconds().toString().padStart(2,'0'),
    // milliseconds: d.getMilliseconds().toString().padStart(4,'0')
  }
  // console.log(`[${t.hours}:${t.minutes}:${t.seconds}.${t.milliseconds}]`, ...args)
  console.log(`[${t.hours}:${t.minutes}:${t.seconds}]`, ...args)
}
export const debug = process.env['DEBUG'] ? (...args) => log('DEBUG:', ...args) : () => {} 
export const archivedImages = new Set()
export let cfg, cdp
let archiverName_, version_

class RegExpCache {
  #cache = new Map()
  #wildcardToRegex
  constructor({wildcardToRegex} = {}) {
    this.#wildcardToRegex = wildcardToRegex
  }
  get(pattern) {
    let regExp = this.#cache.get(pattern)
    if (!regExp) {
      regExp = this.#wildcardToRegex ? wildcardToRegex(pattern) : new RegExp(pattern)
      this.#cache.set(pattern, regExp)
    }
    return regExp
  }
  testMultiple(string, patterns) {
    for (const pattern of patterns) {
      if (this.get(pattern).test(string)) {
        return true
      }
    }
  }
}

export function startup({archiverName, version, initialUrl, catchResponses, responseReceivedHandler, targetHandler, requestPausedHandler, discoverTargetsFilter}) {
  version_ = version
  archiverName_ = archiverName
  logInfo('Using '+archiverName+' version:', version)
  handleCliArguments()
  try {
    detectArchivedImages() // by checking the DB records
  } catch {}
  logInfo(`Images archived: ${archivedImages.size}.`)
  initializeIntercept({initialUrl, catchResponses, responseReceivedHandler, targetHandler, requestPausedHandler, discoverTargetsFilter})
}

function getImgExt(buffer) {
  const magicMarkers = {
    '424d': 'bmp',
    'ffd8ff': 'jpg',
    '47494638': 'gif',
    '89504e470d0a1a0a': 'png',
    '5249464657454250': 'webp',
  }
  const firstBytes = buffer.subarray(0, 8).toString('hex')
  for (const [marker, ext] of Object.entries(magicMarkers)) {
    if (firstBytes.startsWith(marker)) {
      return ext
    }
  }
  throw 'Unknown image type.'
}

/** Archive the `imgData` buffer using the `details` which must include `{id, prompt, unixTime}`. */
export function archiveImage({id, details, imgData}) {
  if (archivedImages.has(''+id)) {
    return
  }
  if (!id) {
    id = crypto.randomUUID()
    debug(`Missing ID, generated one: ${id}`)
  }
  if (!details) {
    debug(`No details for: ${id}`)
    details = {}
  }
  if (imgData.byteLength == 0) {
    throw `Error, zero length: ${id}`
  }
  details.id = id // ensure it includes it
  details.prompt ??= '[unknown prompt]'
  details.unixTime ??= Math.trunc(Date.now() / 1000)
  log(`Archiving: ${details.id} - ${details.prompt}`)
  const ext = getImgExt(imgData)
  const imgPath = `${cfg.archivePath}/images/${dateDir(details.unixTime)}/${imgFilename(details)}.${ext}`
  fs.writeFileSync(ensureDirectory(imgPath), imgData)
  if (!process.env['SKIP_RECORD']) {
    const recPath = `${cfg.archivePath}/database/${dateDir(details.unixTime)}/${details.id}.json`
    fs.writeFileSync(ensureDirectory(recPath), JSON.stringify(details, null, 2))
    archivedImages.add(''+details.id)
  }
}

/** Returns the body as a Buffer (this stops the streaming of this response to the browser, it will be delivered all at once instead). */
export async function getResponseBody({asFetch, requestId, sessionId}) {
  const {body, base64Encoded} = await cdp.send(
    (asFetch ? 'Fetch' : 'Network') + '.getResponseBody', 
    {requestId}, sessionId
  )
  return Buffer.from(body, base64Encoded ? 'base64' : 'utf-8')
}

async function initializeIntercept({initialUrl, catchResponses, responseReceivedHandler, targetHandler, requestPausedHandler, discoverTargetsFilter}) {
  if ((catchResponses || responseReceivedHandler) && !(catchResponses && responseReceivedHandler)) {
    throw `responseReceivedHandler must be used together with catchResponses`
  }
  logInfo('Connecting to the Chrome DevTools Protocol... ')
  const connectToChrome = async () => {
    try {
      if (initialUrl) {
        cfg.chromiumArgs = [initialUrl]
      }
      const {info} = await initChrome(cfg)
      return info.webSocketDebuggerUrl
    } catch (error) {
      if (error.toString().startsWith(`Error: Can't connect to the DevTools protocol`)) {
        console.error(`Could not connect. This usually means that your browser was already running (but without having the CDP port set). If that's the case just close it and run this program again, it will then launch it for you with the correct CDP port configured.`)
      } else {
        console.error(error)
        console.error(`Something went wrong when launching (or connecting to) your browser. Is this the correct path? "${cfg.chromiumPath}"\nIf not then change it in "${cfg.cfgFileName}".`)
      }
      process.exit(1)
    }
  }
  const webSocketDebuggerUrl = cfg.webSocketDebuggerUrl || await connectToChrome()
  if (cfg.printWebSocketDebuggerUrl) {
    console.log('webSocketDebuggerUrl: '+webSocketDebuggerUrl)
  }
  const sessions = new Map()
  const regExpCache = new RegExpCache({wildcardToRegex: true})
  const networkResponseCatchQueue = new Map()

  cdp = new ChromeDevToolsProtocol({webSocketDebuggerUrl, debug: process.env['DEBUG_CDP']})
  cdp.once('error', (error) => {
    logInfo(`The CDP WebSocket connection failed with an error:`, ''+error)
    process.exit()
  })
  cdp.once('close', () => {
    logInfo(`The CDP WebSocket connection was closed. Please reconnect by running this program again (if you're not finished).`)
    process.exit()
  })

  cdp.on('Target.targetCreated',     inspectTargetOrNot)
  cdp.on('Target.targetInfoChanged', inspectTargetOrNot)
  // check if all using noNetwork, then we can skip enabling it
  async function inspectTargetOrNot({targetInfo: {targetId, url, type}}) {
    const shouldInspectBy = {targetHandler: 0b01, responseCatcher: 0b10}
    const beingInspected = sessions.has(targetId)
    let shouldInspect = 0, patterns = [], networkFetchEnabled, registerInspectionResolve
    /** Used by targetHandler to register interest in inspection (can set shouldInspect) */
    const registerInspection = (intercept = []) => {
      shouldInspect |= shouldInspectBy.targetHandler
      patterns.push(...intercept)
      return new Promise(resolve => {
        registerInspectionResolve = resolve
      })
    }
    // check if catchResponses is interested
    for (let {from, intercept, serviceWorkerOnly, enableNetworkFetch} of catchResponses) {
      if (typeof from == 'string') from = [from] 
      if (typeof intercept == 'string') intercept = [intercept] 
      if (regExpCache.testMultiple(url, from) && (!serviceWorkerOnly || type == 'service_worker')) {
        patterns.push(...intercept)
        if (enableNetworkFetch) {
          networkFetchEnabled = true
        }
      }
    }
    if (patterns.length) {
      shouldInspect |= shouldInspectBy.responseCatcher
    }
    if (targetHandler) { // check if targetHandler is interested
      // even if targetHandler is async the code inside of it is sync before any async part is awaited, hence calling registerInspection from it before such a part (if any) which sets shouldInspect works fine
      targetHandler(type, url, registerInspection) // (this can set shouldInspect)
    }
    // if any is interested in inspection and not already inspected
    if (shouldInspect && !beingInspected) {
      try {
        // bind target to a session
        const session = cdp.newSession({targetId})
        debug('start monitor:', targetId, url)
        sessions.set(targetId, session)
        session.once('detached', () => {
          debug('stop monitor:', targetId, url)
          sessions.delete(targetId)
        })
        await session.ready // any errors will throw here
        // resolve it with the session so it can use it for whatever
        registerInspectionResolve?.(session)
        if (shouldInspect & shouldInspectBy.responseCatcher) {
          await session.send('Fetch.enable', {
            patterns: patterns.map(urlPattern => {return {urlPattern, requestStage: 'Response'}})
          })
          if (networkFetchEnabled) {
            // this will sometimes catch stuff from cache that fetch has problems catching
            debug('networkFetchEnabled')
            await session.send('Network.enable')
            session.on('Network.requestWillBeSent', ({request, requestId}) => {
              if (regExpCache.testMultiple(request.url, patterns)) {
                const details = {initiator: url, asFetch: false, requestId, sessionId: session.id, request}
                networkResponseCatchQueue.set(requestId, details)
              }
            })
            session.on('Network.responseReceived', ({response, requestId}) => {
              const result = networkResponseCatchQueue.get(requestId)
              if (result) {
                result.response = response
              }
            })
            session.on('Network.loadingFinished', ({requestId}) => {
              const result = networkResponseCatchQueue.get(requestId)
              if (result) {
                networkResponseCatchQueue.delete(requestId)
                // debug('Network.loadingFinished', result.response.status, result.request.url)
                responseReceivedHandler(result)
              }
            })
          }
        }
        session.on('Fetch.requestPaused', async (args) => {
          const {requestId, networkId, request, responseStatusCode, responseHeaders, responseStatusText} = args
          // debug('Fetch.requestPaused', responseStatusCode, request.url.split('?')[0])
          let doNotContinue
          try {
            if (shouldInspect & shouldInspectBy.responseCatcher) {
              // log('abort network catch', networkId)
              networkResponseCatchQueue.delete(networkId) // abort network catch
              // reponse header but not the body (it can be fetched with "Fetch.getResponseBody" if wanted)
              await responseReceivedHandler({initiator: url, asFetch: true, requestId, networkId, sessionId: session.id, request, response: {
                status: responseStatusCode,
                statusText: responseStatusText,
                headers: responseHeaders
              }})
            }
            if (shouldInspect & shouldInspectBy.targetHandler) {
              if (requestPausedHandler) {
                doNotContinue = await requestPausedHandler(args)
              }
            }
          } catch (error) {
            debug(error)
          } finally {
            if (!doNotContinue) {
              session.send('Fetch.continueRequest', {requestId}).catch(debug)
            }
          }
        })
      } catch (error) { // e.g. if target has been destroyed
        debug('error monitor:', error)
        registerInspectionResolve?.(false)
      }
    } else {
      registerInspectionResolve?.(false)
    }
    if (beingInspected && !shouldInspect) { // (if url changed)
      sessions.get(targetId).detach().catch(debug)
      sessions.delete(targetId)
    }
  }

  await cdp.ready
  logInfo('Connection successful!')

  await cdp.send('Target.setDiscoverTargets', {
    discover: true, // turn on
    filter: discoverTargetsFilter || [
      {type: 'page'},
      {type: 'service_worker'}
    ]
  })
}

function detectArchivedImages() {
  const dirsToScan = [`${cfg.archivePath}/database`]
  let path
  while (path = dirsToScan.pop()) {
    for (const entry of fs.readdirSync(path, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        dirsToScan.push(path+'/'+entry.name)
        continue
      }
      if (entry.isFile && entry.name.endsWith('.json')) {
        const imgId = entry.name.slice(0, -5) // without .json
        archivedImages.add(imgId)
      }
    }
  }
}

function handleCliArguments() {
  const argMap = parseCliArgs(true)
  if (argMap.has('--config')) {
    cfg = loadConfig(argMap.get('--config').value)
  } else {
    cfg = loadConfig()
  }
  logInfo('Using archive directory:', cfg.archivePath)
  for (const [title, value] of argMap) {
    switch (title) {
      default: // notice how these ends at process.exit() below
        logInfo(`Invalid CLI command: ${cmd}`)
      case '-h': case '--help': 
        logInfo(`Usage: [--config=location] \nSee https://github.com/JoakimCh/${archiverName_} for more help.`)
      case '-v': case '-V': case '--version':
        process.exit()
      case '--webSocketDebuggerUrl':
        cfg.webSocketDebuggerUrl = value
      break
      case '--printWebSocketDebuggerUrl':
        cfg.printWebSocketDebuggerUrl = true
      break
    }
  }
}

function loadConfig(cfgPath = `${archiverName_}.json`) {
  const cfgFileName = n_path.basename(cfgPath)
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    if (!(typeof cfg.cdpPort == 'number')) throw `Missing cdpPort in ${cfgFileName}.`
    if (!(typeof cfg.chromiumPath == 'string')) throw `Missing chromiumPath in ${cfgFileName}.`
    if (!(typeof cfg.archivePath == 'string')) throw `Missing archivePath in ${cfgFileName}.`
    if (cfg.archivePath.endsWith('/') || cfg.archivePath.endsWith('\\')) {
      cfg.archivePath = cfg.archivePath.slice(0, -1)
    }
    if (!n_path.isAbsolute(cfg.archivePath)) throw 'The archivePath must be absolute, not this relative path: '+cfg.archivePath
    cfg.archivePath = cfg.archivePath.replaceAll('\\', '/') // (Windows is FINE with /, we can even mix them)
  } catch (error) {
    logInfo(`No valid ${cfgFileName} found, creating one with default values. Please check it before running me again! The error message was:`, error.message)
    try {
      cfg = { // some sane defaults
        cdpPort: randomInt(10000, 65534), // some security is provided by not using the default port
        chromiumPath: (()=>{
          switch (process.platform) {
            default:
              return 'google-chrome'
            case 'win32':
              return pickPathThatExists([
                '%ProgramFiles%/Google/Chrome/Application/chrome.exe',
                '%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe',
                '%LocalAppData%/Google/Chrome/Application/chrome.exe'
              ]) || 'c:/path/to/chromium-compatible-browser.exe'
            case 'darwin':
              return pickPathThatExists(['~/Library/Application Support/Google/Chrome']) || '/path/to/chromium-compatible-browser'
          }
        })(),
        archivePath: process.platform == 'win32' ? process.cwd().replaceAll('\\', '/') : process.cwd()
      }
      ensureDirectory(cfgPath)
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    } catch (error) {
      logInfo('Failed creating it, error:', error)
    }
    process.exit()
  }
  cfg.cfgFileName = cfgFileName
  return cfg
}

function pickPathThatExists(choices) {
  for (let path of choices) {
    if (process.platform == 'win32') {
      // thanks to: https://stackoverflow.com/a/33017068/4216153
      path = path.replace(/%([^%]+)%/g, (_, key) => process.env[key]).replaceAll('\\', '/')
    }
    if (fs.existsSync(path)) {
      return path
    }
  }
}

function dateDir(unixTime) {
  const date = new Date(unixTime * 1000)
  return `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`
}

function ensureDirectory(filePath) {
  const dirPath = n_path.dirname(filePath)
  if (!(fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory())) {
    fs.mkdirSync(dirPath, {recursive: true})
  }
  return filePath
}

function imgFilename({id, prompt}) {
  const maxLength = 240
  prompt = prompt
    .replaceAll('. ','_')
    .replaceAll(', ','_')
    .replaceAll('.','_')
    .replaceAll(',','_')
    .replaceAll(' ','-')
    .replace(/[^a-z-_0-9]/gi, '')
  if (prompt.endsWith('_') || prompt.endsWith('-')) {
    prompt = prompt.slice(0, -1)
  }
  const filename = `${id}-${prompt}`
  if (filename.length > maxLength) {
    return filename.slice(0, maxLength) + '…'
  }
  return filename
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

/* Parse command line interface arguments and return them in an Object or a Map. */
function parseCliArgs(asMap = false) {
  function wrappedIn(value, ...chars) {
    for (const char of chars) {
      if (value.startsWith(char) && value.endsWith(char)) {
        return char
      }
    }
  }
  const args = (asMap ? new Map() : {})
  for (const arg of process.argv.slice(2)) {
    let title, value
    const eqSign = arg.indexOf('=')
    if (eqSign != -1) {
      title = arg.slice(0, eqSign)
      value = arg.slice(eqSign +1)
      if (wrappedIn(value, `'`, '"')) {
        value = value.slice(1,-1)
      }
    } else {
      title = arg
    }
    if (asMap) {
      args.set(title, value)
    } else {
      args[title] = value
    }
  }
  return args
}

export function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex characters
  const regexPattern = escaped
    .replace(/\*/g, '.*') // convert * to .*
    .replace(/\?/g, '.')  // convert ? to .
  return new RegExp(`^${regexPattern}$`)
}
