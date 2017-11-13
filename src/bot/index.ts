const { EventEmitter } = require('events')
const deepEqual = require('deep-equal')
const clone = require('clone')
const validateResource = require('@tradle/validate-resource')
const { setVirtual } = validateResource.utils
const buildResource = require('@tradle/build-resource')
const createHooks = require('event-hooks')
const BaseModels = require('../models')
const installDefaultHooks = require('./default-hooks')
const makeBackwardsCompat = require('./backwards-compat')
const errors = require('../errors')
const types = require('../typeforce-types')
const {
  co,
  extend,
  omit,
  pick,
  typeforce,
  isPromise,
  waterfall,
  series
} = require('../utils')
const { addLinks } = require('../crypto')
const { prettify } = require('../string-utils')
const { getMessagePayload, getMessageGist } = require('./utils')
const locker = require('./locker')
const defaultTradleInstance = require('../').tradle
const { constants } = defaultTradleInstance
const { TYPE, SIG } = constants
const createUsers = require('./users')
// const RESOLVED = Promise.resolve()
const promisePassThrough = data => Promise.resolve(data)

const COPY_TO_BOT = [
  'aws', 'models', 'objects', 'db', 'conf', 'kv', 'seals', 'seal',
  'identities', 'users', 'history', 'graphqlAPI', 'messages',
  'resources', 'sign', 'send', 'getMyIdentity', 'env'
]

const HOOKABLE = [
  { name: 'message', source: 'lambda' },
  { name: 'seal', source: 'dynamodbstreams' },
  { name: 'readseal', source: 'dynamodbstreams' },
  { name: 'wroteseal', source: 'dynamodbstreams' },
  { name: 'usercreate' },
  { name: 'useronline' },
  { name: 'useroffline' },
  { name: 'messagestream', source: 'dynamodbstreams' }
]

exports = module.exports = createBot
exports.inputs = require('./inputs')
exports.lambdas = require('./lambdas')
exports.fromEngine = opts => createBot(exports.inputs(opts))

/**
 * bot engine factory
 * @param  {Object}             opts
 * @param  {Boolean}            opts.autosave if false, will not autosave user after every message receipt
 * @param  {Object}             opts.models
 * @param  {Function}           opts.send
 * @param  {Function}           opts.sign
 * @param  {Function}           opts.seals.get
 * @param  {Function}           opts.seals.create
 * @param  {Object}             opts.identities
 * @param  {Object}             opts.db
 * @param  {Object}             opts.history
 * @param  {Object}             opts.graphqlAPI
 * @param  {Object}             opts.resources physical ids of cloud resources
 * @return {BotEngine}
 */
function createBot (opts={}) {
  let {
    autosave=true,
    models,
    resources,
    send,
    sign,
    seals,
    env={}
  } = opts

  const {
    TESTING,
    FUNCTION_NAME
  } = env

  const logger = env.sublogger('bot-engine')
  const isGraphQLLambda = TESTING || /graphql/i.test(FUNCTION_NAME)
  const isGenSamplesLambda = TESTING || /sample/i.test(FUNCTION_NAME)
  const MESSAGE_LOCK_TIMEOUT = TESTING ? null : 10000

  const missingBaseModels = Object.keys(BaseModels).filter(id => !models[id])
  if (missingBaseModels.length) {
    throw new Error(`expected models to have @tradle/models and @tradle/custom-models, missing: ${missingBaseModels.join(', ')}`)
  }

  const bot = new EventEmitter()
  extend(bot, pick(opts, COPY_TO_BOT))
  bot.logger = logger
  bot.debug = logger.debug
  bot.users = bot.users || createUsers({
    table: resources.tables.Users,
    oncreate: user => hooks.fire('usercreate', user)
  })

  bot.save = resource => bot.db.put(ensureTimestamped(resource))
  bot.update = resource => bot.db.update(ensureTimestamped(resource))
  bot.send = co(function* (opts) {
    let { link, object, to } = opts
    if (!object && link) {
      object = yield bot.objects.get(link)
    }

    try {
      if (object[SIG]) {
        typeforce(types.signedObject, object)
      } else {
        typeforce(types.unsignedObject, object)
      }

      typeforce({
        to: typeforce.oneOf(typeforce.String, typeforce.Object),
        other: typeforce.maybe(typeforce.Object)
      }, opts)
    } catch (err) {
      throw new errors.InvalidInput(`invalid params to send: ${prettify(opts)}, err: ${err.message}`)
    }

    bot.objects.presignEmbeddedMediaLinks(object)
    opts = omit(opts, 'to')
    opts.recipient = to.id || to
    // if (typeof opts.object === 'string') {
    //   opts.object = {
    //     [TYPE]: 'tradle.SimpleMessage',
    //     message: opts.object
    //   }
    // }

    const payload = opts.object
    const model = models[payload[TYPE]]
    if (model) {
      try {
        validateResource({ models, model, resource: payload })
      } catch (err) {
        logger.error('failed to validate resource', {
          resource: payload,
          error: err.stack
        })

        throw err
      }
    }

    const message = yield send(opts)
    if (TESTING && message) {
      yield savePayloadToTypeTable(clone(message))
    }

    return message
  })

  bot.resolveEmbeds = bot.objects.resolveEmbeds
  bot.presignEmbeddedMediaLinks = bot.objects.presignEmbeddedMediaLinks

  // bot.loadEmbeddedResource = function (url) {
  //   return uploads.get(url)
  // }

  bot.version = co(function* (resource) {
    const latest = buildResource.version(resource)
    yield bot.sign(latest)
    addLinks(latest)
    return latest
  })

  bot.signAndSave = co(function* (resource) {
    yield bot.sign(resource)
    addLinks(resource)
    yield bot.save(resource)
    return resource
  })

  bot.versionAndSave = co(function* (resource) {
    const newVersion = yield bot.version(resource)
    yield this.save(newVersion)
    return newVersion
  })

  bot.reSign = function reSign (object) {
    return bot.sign(omit(object, [SIG]))
  }

  // setup hooks
  const hooks = createHooks()
  bot.hook = hooks.hook
  const { savePayloadToTypeTable } = installDefaultHooks({ bot, hooks })

  // START preprocessors
  const normalizeOnSealInput = co(function* (data) {
    data.bot = bot
    return data
  })

  const messageProcessingLocker = locker({
    name: 'message processing lock',
    debug: env.sublogger('message-locker').debug,
    timeout: MESSAGE_LOCK_TIMEOUT
  })

  const normalizeOnMessageInput = co(function* (message) {
    if (typeof message === 'string') {
      message = JSON.parse(message)
    }

    const userId = message._author
    yield messageProcessingLocker.lock(userId)

    let [payload, user] = [
      yield getMessagePayload({ bot, message }),
      // identity permalink serves as user id
      yield bot.users.createIfNotExists({ id: userId })
    ]

    payload = extend(message.object, payload)
    const _userPre = clone(user)
    const type = payload[TYPE]
    addLinks(payload)
    if (TESTING) {
      yield savePayloadToTypeTable(clone(message))
    }

    logger.debug('receiving', getMessageGist(message))
    return {
      bot,
      user,
      message,
      payload,
      _userPre,
      type,
      link: payload._link,
      permalink: payload._permalink,
    }
  })

  // END preprocessors

  const promiseSaveUser = co(function* ({ user, _userPre }) {
    if (!deepEqual(user, _userPre)) {
      logger.debug('merging changes to user state')
      yield bot.users.merge(user)
      return
    }

    logger.debug('user state was not changed by onmessage handler')
  })

  const preProcessHooks = createHooks()
  preProcessHooks.hook('message', normalizeOnMessageInput)
  preProcessHooks.hook('seal', normalizeOnSealInput)

  const postProcessHooks = createHooks()
  if (autosave) {
    postProcessHooks.hook('message', promiseSaveUser)
  }

  postProcessHooks.hook('message', (opts, result) => {
    const { user } = opts
    messageProcessingLocker.unlock(user.id)
    bot.emit('sent', {
      to: opts.recipient,
      result
    })
  })

  postProcessHooks.hook('message:error', ({ payload }) => {
    if (typeof payload === 'string') {
      payload = JSON.parse(payload)
    }

    messageProcessingLocker.unlock(payload._author)
  })

  postProcessHooks.hook('readseal', emitAs('seal:read'))
  postProcessHooks.hook('wroteseal', emitAs('seal:wrote'))
  postProcessHooks.hook('sealevent', emitAs('seal'))
  postProcessHooks.hook('usercreate', emitAs('user:create'))
  postProcessHooks.hook('useronline', emitAs('user:online'))
  postProcessHooks.hook('useroffline', emitAs('user:offline'))

  const finallyHooks = createHooks()
  // invocations are wrapped to preserve context
  const processEvent = co(function* (event, payload) {
    const originalPayload = { ...payload }
    yield promiseReady
    try {
      // waterfall to preprocess
      payload = yield preProcessHooks.waterfall(event, payload)
      // bubble to allow handlers to terminate processing
      const result = yield hooks.bubble(event, payload)
      yield postProcessHooks.fire(event, payload, result)
    } catch (error) {
      logger.error(`failed to process ${event}`, {
        event,
        payload: originalPayload,
        error: error.stack
      })

      yield postProcessHooks.fire(`${event}:error`, { payload, error })
    }
  })

  const promiseReady = new Promise(resolve => {
    bot.ready = resolve
  })

  bot.use = (strategy, opts) => strategy(bot, opts)

  // START exports
  // events like messages, seals arrive through here
  bot.process = {}

  HOOKABLE.forEach(({ name, source, type }) => {
    const processor = event => processEvent(name, event)
    bot.process[name] = {
      source,
      type,
      handler: processor
    }
  })

  bot.use = (strategy, opts) => strategy(bot, opts)

  // alias
  Object.defineProperty(bot, 'addressBook', {
    get () {
      return bot.identities
    }
  })

  if (bot.graphqlAPI) {
    bot.process.graphql = {
      type: 'wrapped',
      source: 'http',
      raw: bot.graphqlAPI.executeQuery,
      handler: require('../http-request-handler')
    }
  }

  if (isGenSamplesLambda) {
    bot.process.samples = {
      path: 'samples',
      handler: co(function* (event) {
        const gen = require('./gen-samples')
        return yield gen({ bot, event })
      })
    }
  }

  // END exports

  if (TESTING) {
    bot.trigger = (event, ...args) => {
      const conf = bot.process[event]
      if (conf) {
        return (conf.raw || conf.handler)(...args)
      }

      return Promise.resolve()
    }

    bot.hooks = hooks
  }

  makeBackwardsCompat(bot)
  return bot

  function emitAs (event) {
    return function (...args) {
      bot.emit(event, ...args)
    }
  }
}

function ensureTimestamped (resource) {
  if (!resource._time) {
    setVirtual(resource, { _time: Date.now() })
  }

  return resource
}
