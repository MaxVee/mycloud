import { EventEmitter } from 'events'
import _ from 'lodash'
// @ts-ignore
import Promise from 'bluebird'
import compose from 'koa-compose'
import { TYPE, SIG } from '@tradle/constants'
import { DB, Filter } from '@tradle/dynamodb'
import buildResource from '@tradle/build-resource'
import validateResource from '@tradle/validate-resource'
import protocol from '@tradle/protocol'
import { mixin as readyMixin, IReady } from './ready-mixin'
import { mixin as modelsMixin } from './models-mixin'
import { topics as EventTopics, toAsyncEvent, toBatchEvent, getSealEventTopic } from './events'
import { requireDefault } from './require-default'
import { createServiceMap } from './service-map'
import { ModelStore, createModelStore } from './model-store'
import { getBuckets } from './buckets'
import { getTables } from './tables'
import createDB from './db'
import { createDBUtils } from './db-utils'
import { createAWSWrapper } from './aws'
import * as utils from './utils'
const {
  defineGetter,
  ensureTimestamped,
  wait,
  parseStub,
  RESOLVED_PROMISE,
  batchProcess,
  getResourceIdentifier,
  pickBacklinks,
  omitBacklinks,
  pluck,
  normalizeSendOpts,
  normalizeRecipient,
  toBotMessageEvent,
  getResourceModuleStore
} = utils

import * as stringUtils from './string-utils'
import baseModels from './models'
import * as crypto from './crypto'
import { createUsers, Users } from './users'
// import { Friends } from './friends'
import { createGraphqlAPI } from './graphql'
import {
  IEndpointInfo,
  ILambdaImpl,
  Lambda,
  LambdaCreator,
  ResourceStub,
  ParsedResourceStub,
  BotStrategyInstallFn,
  ILambdaOpts,
  ITradleObject,
  IDeepLink,
  IBotOpts,
  AppLinks,
  IGraphqlAPI,
  IBotMiddlewareContext,
  HooksFireFn,
  HooksHookFn,
  Seal,
  IBotMessageEvent,
  IKeyValueStore,
  ISaveEventPayload,
  GetResourceIdentifierInput,
  IHasModels,
  Model,
  Diff,
  IServiceMap,
  Buckets,
  Tables,
  Bucket,
  IMailer
} from './types'

import { createLinker, appLinks as defaultAppLinks } from './app-links'
import { createLambda } from './lambda'
import { createLocker, Locker } from './locker'
import { Logger } from './logger'
import Env from './env'
import Events from './events'
import Identity from './identity'
import Objects from './objects'
import Messages from './messages'
import Identities from './identities'
import Auth from './auth'
import Push from './push'
import Seals from './seals'
import Blockchain from './blockchain'
import Backlinks from './backlinks'
import Mailer from './mailer'
import Delivery from './delivery'
import Discovery from './discovery'
import Friends from './friends'
import Init from './init'
import User from './user'
import Storage from './storage'
import TaskManager from './task-manager'
import Messaging from './messaging'
import S3Utils from './s3-utils'
import LambdaUtils from './lambda-utils'
import StackUtils from './stack-utils'
import Iot from './iot-utils'
import ContentAddressedStore from './content-addressed-store'
import KV from './kv'
import { AwsApis } from './aws'
import Errors from './errors'
import { MiddlewareContainer } from './middleware-container'
import { hookUp as setupDefaultHooks } from './hooks'
import { Resource, ResourceInput, IResourcePersister } from './resource'
import networks from './networks'
import constants from './constants'

const { addLinks } = crypto

type LambdaImplMap = {
  [name:string]: ILambdaImpl
}

type LambdaMap = {
  [name:string]: LambdaCreator
}

type GetResourceOpts = {
  backlinks?: boolean|string[]
  resolveEmbeds?: boolean
}

type SendInput = {
  to: string | { id: string }
  object?: any
  link?: string
}

export const createBot = (opts:IBotOpts={}):Bot => new Bot(opts)

// this is not good TypeScript,
// we lose all type checking when exporting like this
const lambdaCreators:LambdaImplMap = {
  get onmessage() { return require('./lambda/onmessage') },
  get onmessagestream() { return require('./lambda/onmessagestream') },
  get onsealstream() { return require('./lambda/onsealstream') },
  get onresourcestream() { return require('./lambda/onresourcestream') },
  get oninit() { return require('./lambda/oninit') },
  // get onsubscribe() { return require('./lambda/onsubscribe') },
  // get onconnect() { return require('./lambda/onconnect') },
  // get ondisconnect() { return require('./lambda/ondisconnect') },
  get oniotlifecycle() { return require('./lambda/oniotlifecycle') },
  get sealpending() { return require('./lambda/sealpending') },
  get pollchain() { return require('./lambda/pollchain') },
  get checkFailedSeals() { return require('./lambda/check-failed-seals') },
  get toevents() { return require('./lambda/to-events') },
  get info() { return require('./lambda/info') },
  get preauth() { return require('./lambda/preauth') },
  get auth() { return require('./lambda/auth') },
  get inbox() { return require('./lambda/inbox') },
  // get graphql() { return require('./lambda/graphql') },
  get warmup() { return require('./lambda/warmup') },
  get reinitializeContainers() { return require('./lambda/reinitialize-containers') },
  get deliveryRetry() { return require('./lambda/delivery-retry') },
  // get oneventstream() { return require('./lambda/oneventstream') },
}

// const middlewareCreators:MiddlewareMap = {
//   get bodyParser() { return require('./middleware/body-parser') }
// }

/**
 * bot engine factory
 * @param  {Object}             opts
 * @return {BotEngine}
 */
export class Bot extends EventEmitter implements IReady, IHasModels {
  public env: Env
  public aws: AwsApis
  // public router: any
  public serviceMap: IServiceMap
  public buckets: Buckets
  public tables: Tables
  public dbUtils: any
  public objects: Objects
  public events: Events
  public identities: Identities
  public identity: Identity
  public storage: Storage
  public messages: Messages
  public db: DB
  public contentAddressedStore:ContentAddressedStore
  public conf:KV
  public kv:KV
  public auth: Auth
  public delivery: Delivery
  public discovery: Discovery
  public seals: Seals
  public blockchain: Blockchain
  public init: Init
  public userSim: User
  public friends: Friends
  public messaging: Messaging
  public pushNotifications: Push
  public s3Utils: S3Utils
  public iot: Iot
  public lambdaUtils: LambdaUtils
  public stackUtils: StackUtils
  public tasks:TaskManager
  public modelStore: ModelStore
  public mailer: IMailer
  public appLinks: AppLinks
  public backlinks: Backlinks
  public logger: Logger
  public graphql: IGraphqlAPI

  public get isDev() { return this.env.STAGE === 'dev' }
  public get isStaging() { return this.env.STAGE === 'staging' }
  public get isProd() { return this.env.STAGE === 'prod' }
  public get isTesting() { return this.env.TESTING }
  public get resourcePrefix() { return this.env.SERVERLESS_PREFIX }
  public get models () { return this.modelStore.models }
  public get lenses () { return this.modelStore.lenses }
  public get secrets(): Bucket {
    return this.buckets.Secrets
  }

  public get apiBaseUrl () {
    return this.serviceMap.RestApi.ApiGateway.url
  }

  public get version () {
    return require('./version')
  }

  public get networks () { return networks }
  public get network () {
    const { BLOCKCHAIN } = this.env
    return this.networks[BLOCKCHAIN.flavor][BLOCKCHAIN.networkName]
  }

  public get constants () { return constants }
  public get errors () { return Errors }
  public get crypto () { return crypto }
  public get utils () { return utils }
  public get stringUtils () { return stringUtils }
  public get addressBook () { return this.identities }

  // public friends: Friends
  public debug: Function
  public users: Users

  // IReady
  public ready: () => void
  public isReady: () => boolean
  public promiseReady: () => Promise<void>

  // IHasModels
  public buildResource: (model: string|Model) => any
  public buildStub: (resource: ITradleObject) => any
  public validate: (resource: ITradleObject) => any

  // public hook = (event:string, payload:any) => {
  //   if (this.isTesting && event.startsWith('async:')) {
  //     event = event.slice(6)
  //   }

  //   return this.middleware.hook(event, payload)
  // }

  public get hook(): HooksHookFn { return this.middleware.hook }
  public get hookSimple(): HooksHookFn { return this.middleware.hookSimple }
  public get fire(): HooksFireFn { return this.middleware.fire }
  public get fireBatch(): HooksFireFn { return this.middleware.fireBatch }

  // shortcuts
  public onmessage = handler => this.middleware.hookSimple(EventTopics.message.inbound.sync, handler)
  public oninit = handler => this.middleware.hookSimple(EventTopics.init.sync, handler)
  public onseal = handler => this.middleware.hookSimple(EventTopics.seal.read.sync, handler)
  public onreadseal = handler => this.middleware.hookSimple(EventTopics.seal.read.sync, handler)
  public onwroteseal = handler => this.middleware.hookSimple(EventTopics.seal.wrote.sync, handler)

  public lambdas: LambdaMap

  // PRIVATE
  private outboundMessageLocker: Locker
  private endpointInfo: Partial<IEndpointInfo>
  private middleware: MiddlewareContainer<IBotMiddlewareContext>
  private _resourceModuleStore: IResourcePersister
  constructor(opts: IBotOpts) {
    super()

    let {
      env=new Env(process.env),
      users,
      ready = true
    } = opts

    if (!(env instanceof Env)) {
      env = new Env(env)
    }

    this.env = env

    readyMixin(this)
    modelsMixin(this)

    this._init()
    this.users = users || createUsers({ bot: this })
    this.debug = this.logger.debug
    // this.friends = new Friends({
    //   bot: this,
    //   logger: this.logger.sub('friends')
    // })

    const MESSAGE_LOCK_TIMEOUT = this.isTesting ? null : 10000
    this.outboundMessageLocker = createLocker({
      // name: 'message send lock',
      // debug: logger.sub('message-locker:send').debug,
      timeout: MESSAGE_LOCK_TIMEOUT
    })

    this._resourceModuleStore = getResourceModuleStore(this)

    this.endpointInfo = {
      aws: true,
      version: this.version,
      ...this.iot.endpointInfo
    }

    this.lambdas = Object.keys(lambdaCreators).reduce((map, name) => {
      map[name] = opts => lambdaCreators[name].createLambda({
        ...opts,
        bot: this
      })

      return map
    }, {})

    let graphql
    Object.defineProperty(this, 'graphql', {
      get() {
        if (!graphql) {
          graphql = createGraphqlAPI({
            bot: this,
            logger: this.logger.sub('graphql')
          })
        }

        return graphql
      }
    })

    this.middleware = new MiddlewareContainer({
      logger: this.logger.sub('mid'),
      getContextForEvent: (event, data) => ({
        bot: this,
        event: data
      })
    })

    if (this.isTesting) {
      const yml = require('./serverless-interpolated')
      const webPort = _.get(yml, 'custom.vars.local.webAppPort', 55555)
      this.appLinks = createLinker({
        web: this.apiBaseUrl.replace(/http:\/\/\d+\.\d+.\d+\.\d+:\d+/, `http://localhost:${webPort}`)
      })

      require('./test-eventstream').simulateEventStream(this)
    } else {
      this.appLinks = defaultAppLinks
    }

    setupDefaultHooks(this)
    if (ready) this.ready()
  }

  private _init = () => {
    // if (++instanceCount > 1) {
    //   if (!env.TESTING) {
    //     throw new Error('multiple instances not allowed')
    //   }
    // }

    const bot = this
    const { env } = bot
    const {
      // FAUCET_PRIVATE_KEY,
      // BLOCKCHAIN,
      SERVERLESS_PREFIX
    } = env

    bot.env = env

    const logger = bot.logger = env.logger
    const { network } = bot

    // singletons

    // instances
    if (env.BLOCKCHAIN.flavor === 'corda') {
      bot.define('seals', './corda-seals', ({ Seals }) => new Seals(bot))
      bot.define('blockchain', './corda-seals', ({ Blockchain }) => new Blockchain({
        env,
        network
      }))

    } else {
      bot.define('seals', './seals', bot.construct)
      bot.define('blockchain', './blockchain', Blockchain => new Blockchain({
        logger: logger.sub('blockchain'),
        network,
        identity: bot.identity
      }))
    }

    // bot.define('faucet', './faucet', createFaucet => createFaucet({
    //   networkName: BLOCKCHAIN.networkName,
    //   privateKey: FAUCET_PRIVATE_KEY
    // }))

    const serviceMap = bot.serviceMap = createServiceMap({ env })
    const aws = bot.aws = createAWSWrapper({
      env,
      logger: logger.sub('aws')
    })

    const dbUtils = bot.dbUtils = createDBUtils({
      aws,
      logger: logger.sub('db-utils'),
      env
    })

    const tables = bot.tables = getTables({ dbUtils, serviceMap })
    const s3Utils = bot.s3Utils = new S3Utils({
      env,
      s3: aws.s3,
      logger: logger.sub('s3-utils')
    })

    const buckets = bot.buckets = getBuckets({
      aws,
      env,
      logger,
      serviceMap,
      s3Utils
    })

    const lambdaUtils = bot.lambdaUtils = new LambdaUtils({
      aws,
      env,
      logger: logger.sub('lambda-utils')
    })

    const stackUtils = bot.stackUtils = new StackUtils({
      apiId: serviceMap.RestApi.ApiGateway.id,
      stackArn: serviceMap.Stack,
      bucket: buckets.PrivateConf,
      aws,
      env,
      lambdaUtils,
      logger: logger.sub('stack-utils')
    })

    const iot = bot.iot = new Iot({
      services: aws,
      env
    })

    const modelStore = bot.modelStore = createModelStore({
      models: baseModels,
      logger: logger.sub('model-store'),
      bucket: buckets.PrivateConf,
      get identities() { return bot.identities },
      get friends() { return bot.friends },
    })

    const tasks = bot.tasks = new TaskManager({
      logger: logger.sub('async-tasks')
    })

    const objects = bot.objects = new Objects({
      env: bot.env,
      buckets: bot.buckets,
      logger: bot.logger.sub('objects'),
      s3Utils: bot.s3Utils
    })

    const identity = bot.identity = new Identity({
      logger: bot.logger.sub('identity'),
      modelStore,
      network: bot.network,
      objects,
      getIdentityAndKeys: () => bot.secrets.getJSON(constants.IDENTITY_KEYS_KEY),
      getIdentity: () => bot.buckets.PrivateConf.getJSON(constants.PRIVATE_CONF_BUCKET.identity),
    })

    const identities = bot.identities = new Identities({
      logger: bot.logger.sub('identities'),
      modelStore,
      // circular ref
      get db() { return bot.db },
      get objects() { return bot.objects },
    })

    const messages = bot.messages = new Messages({
      logger: logger.sub('messages'),
      objects,
      env,
      identities,
      // circular ref
      get db() { return bot.db },
    })

    const db = bot.db = createDB({
      aws,
      modelStore,
      objects,
      dbUtils,
      messages,
      logger: logger.sub('db')
    })

    const storage = bot.storage = new Storage({
      objects,
      db,
      logger: logger.sub('storage')
    })

    const messaging = bot.messaging = new Messaging({
      network,
      logger: logger.sub('messaging'),
      identity,
      storage,
      env,
      objects,
      identities,
      messages,
      modelStore,
      db,
      tasks,
      get seals () { return bot.seals },
      get friends() { return bot.friends },
      get delivery() { return bot.delivery },
      get pushNotifications() { return bot.pushNotifications },
      get auth() { return bot.auth },
    })

    const friends = bot.friends = new Friends({
      get identities() { return bot.identities },
      storage,
      identity,
      logger: bot.logger.sub('friends'),
      isTesting: bot.env.TESTING,
    })

    const contentAddressedStore = bot.contentAddressedStore = new ContentAddressedStore({
      bucket: buckets.PrivateConf.folder('content-addressed')
    })

    // bot.define('conf', './key-value-table', ctor => {
    //   return new ctor({
    //     table: bot.tables.Conf
    //   })
    // })

    // bot.define('kv', './key-value-table', ctor => {
    //   return new ctor({
    //     table: bot.tables.KV
    //   })
    // })

    const kv = bot.kv = new KV({ db })

    bot.kv = bot.kv.sub('bot:kv:')
    bot.conf = bot.kv.sub('bot:conf:')

    const auth = bot.auth = new Auth({
      env,
      uploadFolder: bot.serviceMap.Bucket.FileUpload,
      logger: bot.logger.sub('auth'),
      aws,
      db,
      identities,
      iot,
      messages,
      objects,
      tasks,
      modelStore,
    })

    const events = bot.events = new Events({
      table: tables.Events,
      dbUtils,
      logger: logger.sub('events')
    })

    bot.define('init', './init', bot.construct)
    bot.define('discovery', './discovery', bot.construct)
    bot.define('userSim', './user', bot.construct)

    const delivery = bot.delivery = new Delivery({
      auth,
      db,
      env,
      friends,
      iot,
      messages,
      modelStore,
      objects,
      logger: logger.sub('delivery')
    })

    // bot.define('router', './router', bot.construct)

    const pushNotifications = bot.pushNotifications = new Push({
      logger: logger.sub('push'),
      serverUrl: constants.PUSH_SERVER_URL[bot.env.STAGE],
      conf: bot.kv.sub('push:')
    })

    // bot.bot = bot.require('bot', './bot')
    bot.define('mailer', './mailer', Mailer => new Mailer({
      client: bot.aws.ses,
      logger: bot.logger.sub('mailer')
    }))

    bot.define('backlinks', './backlinks', Backlinks => new Backlinks({
      storage,
      modelStore,
      logger: logger.sub('backlinks'),
      identity
    }))

    // this.define('faucet', './faucet', createFaucet => createFaucet({
    //   networkName: BLOCKCHAIN.networkName,
    //   privateKey: FAUCET_PRIVATE_KEY
    // }))
  }

  public getEndpointInfo = async (): Promise<IEndpointInfo> => {
    return {
      ...this.endpointInfo,
      endpoint: await this.iot.getEndpoint()
    }
  }

  public toMessageBatch = (batch) => {
    const recipients = pluck(batch, 'to').map(normalizeRecipient)
    if (_.uniq(recipients).length > 1) {
      throw new Errors.InvalidInput(`expected a single recipient`)
    }

    const n = batch.length
    return batch.map((opts, i) => ({
      ...opts,
      other: {
        ..._.clone(opts.other || {}),
        iOfN: {
          i: i + 1,
          n
        }
      }
    }))
  }

  public sendBatch = async (batch) => {
    return this.send(this.toMessageBatch(batch))
  }

  public send = async (opts) => {
    const batch = await Promise.map([].concat(opts), oneOpts => normalizeSendOpts(this, oneOpts))
    const byRecipient = _.groupBy(batch, 'recipient')
    const recipients = Object.keys(byRecipient)
    this.logger.debug(`queueing messages to ${recipients.length} recipients`, {
      recipients
    })

    const results = await Promise.map(recipients, async (recipient) => {
      return await this._sendBatch({ recipient, batch: byRecipient[recipient] })
    })

    const messages = _.flatten(results)
    if (messages) {
      return Array.isArray(opts) ? messages : messages[0]
    }
  }

  public _sendBatch = async ({ recipient, batch }) => {
    const types = batch.map(m => m[TYPE]).join(', ')
    this.logger.debug(`sending to ${recipient}: ${types}`)
    await this.outboundMessageLocker.lock(recipient)
    let messages
    try {
      messages = await this.messaging.queueMessageBatch(batch)
      this.tasks.add({
        name: 'delivery:live',
        promiser: () => this.messaging.attemptLiveDelivery({
          recipient,
          messages
        })
      })

      if (this.middleware.hasSubscribers(EventTopics.message.outbound.sync) ||
        this.middleware.hasSubscribers(EventTopics.message.outbound.sync.batch)) {
        const user = await this.users.get(recipient)
        await this._fireMessageBatchEvent({
          async: true,
          spread: true,
          batch: messages.map(message => toBotMessageEvent({
            bot: this,
            message,
            user
          }))
        })
      }
    } finally {
      this.outboundMessageLocker.unlock(recipient)
    }

    return messages
  }

  public sendPushNotification = (recipient: string) => this.messaging.sendPushNotification(recipient)
  public registerWithPushNotificationsServer = () => this.messaging.registerWithPushNotificationsServer()
  public sendSimpleMessage = async ({ to, message }) => {
    return await this.send({
      to,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        message
      }
    })
  }

  // make sure bot is ready before lambda exits

  public setCustomModels = pack => this.modelStore.setCustomModels(pack)
  public initInfra = (opts?) => this.init.initInfra(opts)
  public updateInfra = (opts?) => this.init.updateInfra(opts)
  public getMyIdentity = () => this.identity.getPublic()
  public getPermalink = () => this.identity.getPermalink()

  public sign = async <T extends ITradleObject>(resource:T, author?):Promise<T> => {
    const payload = { object: resource }

    // allow middleware to modify
    await this.fire(EventTopics.resource.sign, payload)

    resource = payload.object
    this.validateResource(resource)

    const model = this.models[resource[TYPE]]
    if (model) {
      const backlinks = this._pickBacklinks(resource)
      if (_.some(backlinks, arr => arr.length)) {
        debugger
        throw new Errors.InvalidInput(`remove backlinks before signing!`)
      }
    }

    return await this.identity.sign({ object: resource, author })
  }

  private _pickBacklinks = resource => pickBacklinks({
    model: this.models[resource[TYPE]],
    resource
  })

  private _omitBacklinks = resource => omitBacklinks({
    model: this.models[resource[TYPE]],
    resource
  })

  public seal = opts => this.seals.create(opts)
  public forceReinitializeContainers = async (functions?: string[]) => {
    if (this.isTesting) return

    await this.lambdaUtils.invoke({
      name: 'reinitialize-containers',
      sync: false,
      arg: functions
    })
  }

  public validateResource = (resource: ITradleObject) => validateResource.resource({
    models: this.models,
    resource
  })

  public updateResource = async ({ type, permalink, props }) => {
    if (!(type && permalink)) {
      throw new Errors.InvalidInput(`expected "type" and "permalink"`)
    }

    const current = await this.getResource({ type, permalink })
    const resource = this.draft({ resource: current })
      .set(props)

    if (!resource.modified) {
      this.logger.debug('nothing changed, skipping updateResource')
      return {
        resource: current,
        changed: false
      }
    }

    resource.version()
    await resource.signAndSave()
    return {
      resource: resource.toJSON({ virtual: true }),
      changed: true
    }
  }

  public createLambda = (opts:ILambdaOpts={}):Lambda => createLambda({
    ...opts,
    bot: this
  })

  public sendIfUnsent = async (opts:SendInput) => {
    const { link, object, to } = opts
    if (!to) throw new Errors.InvalidInput('expected "to"')

    if (!link && !object[SIG]) {
      throw new Errors.InvalidInput(`expected "link" or signed "object"`)
    }

    try {
      return this.getMessageWithPayload({
        inbound: false,
        link: link || buildResource.link(object),
        recipient: normalizeRecipient(to)
      })
    } catch (err) {
      Errors.ignoreNotFound(err)
    }

    return this.send(opts)
  }

  public getMessageWithPayload = async ({ link, author, recipient, inbound, select }: {
    link: string
    author?: string
    recipient?: string
    inbound?: boolean
    select?: string[]
  }) => {
    const filter:Filter = {
      EQ: {
        [TYPE]: 'tradle.Message',
        _payloadLink: link
      }
    }

    if (typeof inbound === 'boolean') {
      filter.EQ._inbound = inbound
    }

    if (author) filter.EQ._author = author
    if (recipient) filter.EQ._recipient = recipient

    return await this.db.findOne({
      select,
      orderBy: {
        property: '_time',
        desc: true
      },
      filter
    })
  }

  public getBacklink = async (props: GetResourceIdentifierInput, backlink: string) => {
    return await this.getBacklinks(props, [backlink])
  }

  public getBacklinks = async (props: GetResourceIdentifierInput, backlinks?: string[]) => {
    const { type, permalink } = getResourceIdentifier(props)
    return await this.backlinks.fetchBacklinks({
      type,
      permalink,
      properties: backlinks
    })
  }

  public getResource = async (props: GetResourceIdentifierInput, opts: GetResourceOpts={}):Promise<ITradleObject> => {
    const { backlinks, resolveEmbeds } = opts
    let promiseResource = this._getResource(props)
    if (resolveEmbeds) {
      promiseResource = promiseResource.then(this.resolveEmbeds)
    }

    if (!backlinks) {
      return await promiseResource
    }

    const { type, permalink, link } = getResourceIdentifier(props)
    const [resource, backlinksObj] = await Promise.all([
      promiseResource,
      this.getBacklinks({ type, permalink }, typeof backlinks === 'boolean' ? null : backlinks)
    ])

    return {
      ...resource,
      ...backlinksObj
    }
  }

  private _getResource = async (props: GetResourceIdentifierInput) => {
    if (props[SIG]) return props

    const { type, permalink, link } = getResourceIdentifier(props)
    if (link) return await this.objects.get(link)

    return await this.db.get({
      [TYPE]: type,
      _permalink: permalink
    })
  }

  public getResourceByStub = this.getResource

  public addBacklinks = async (resource: ITradleObject) => {
    const backlinks = await this.getBacklinks(resource)
    return _.extend(resource, backlinks)
  }

  public resolveEmbeds = object => this.objects.resolveEmbeds(object)
  public presignEmbeddedMediaLinks = object => this.objects.presignEmbeddedMediaLinks(object)
  public createNewVersion = async (resource) => {
    const latest = buildResource.version(resource)
    const signed = await this.sign(latest)
    addLinks(signed)
    return signed
  }

  public draft = (opts: Partial<ResourceInput>) => {
    return new Resource({
      store: this._resourceModuleStore,
      ...opts
    })
  }

  public signAndSave = async <T extends ITradleObject>(resource:T):Promise<T> => {
    const signed = await this.sign(resource)
    addLinks(signed)
    await this.save(signed)
    return signed
  }

  public versionAndSave = async <T>(resource:T):Promise<T> => {
    const newVersion = await this.createNewVersion(resource)
    await this.save(newVersion)
    return newVersion
  }

  public witness = (object: ITradleObject) => this.identity.witness({ object })

  public reSign = (object:ITradleObject) => this.sign(<ITradleObject>_.omit(object, [SIG]))
  // public fire = async (event, payload) => {
  //   return await this.middleware.fire(event, payload)
  // }

  public ensureDevStage = (msg?: string) => {
    if (!this.isDev) throw new Errors.DevStageOnly(msg || 'forbidden')
  }

  public getStackResourceName = (shortName:string) => {
    return this.env.getStackResourceName(shortName)
  }

  public save = async (resource:ITradleObject, diff?:Diff) => {
    if (!this.isReady()) {
      this.logger.debug('waiting for this.ready()')
      await this.promiseReady()
    }

    try {
      await this.storage.save({
        object: resource,
        diff
      })

      // await this.bot.hooks.fire(`save:${method}`, resource)
    } catch (err) {
      this.logger.debug(`save failed`, {
        type: resource[TYPE],
        link: resource._link,
        input: err.input,
        error: err.stack
      })

      return // prevent further processing
    }
  }

  // public _fireSealBatchEvent = async (event: string, seals: Seal[]) => {
  //   return await this.fireBatch(toAsyncEvent(event), seals)
  // }

  public _fireSealBatchEvent = async (opts: {
    async?: boolean
    spread?: boolean
    event: string
    seals: Seal[]
  }) => {
    const { async, spread, seals } = opts
    const event = async ? toAsyncEvent(opts.event) : opts.event
    const payloads = seals.map(seal => ({ seal }))
    return spread
      ? await this.fireBatch(event, payloads)
      : await this.fire(toBatchEvent(event), payloads)
  }

  public _fireSealEvent = async (opts: {
    async?: boolean
    event: string
    seal: Seal
  }) => {
    const event = opts.async ? toAsyncEvent(opts.event) : opts.event
    return await this.fire(event, { seal: opts.seal })
  }

  public _fireSaveBatchEvent = async (opts: {
    changes: ISaveEventPayload[]
    async?: boolean
    spread?: boolean
  }) => {
    const { changes, async, spread } = opts
    const base = EventTopics.resource.save
    const topic = async ? base.async : base.sync
    const payloads = await Promise.map(changes, change => maybeAddOld(this, change, async))
    return spread
      ? await this.fireBatch(topic, payloads)
      : await this.fire(topic.batch, payloads)
  }

  public _fireSaveEvent = async (opts: {
    change: ISaveEventPayload
    async?: boolean
  }) => {
    const { change, async } = opts
    const base = EventTopics.resource.save
    const topic = async ? base.async : base.sync
    const payload = await maybeAddOld(this, change, async)
    return await this.fire(topic, payload)
  }

  public _fireMessageBatchEvent = async (opts: {
    batch: IBotMessageEvent[]
    async?: boolean
    spread?: boolean
    inbound?: boolean
  }) => {
    const { batch, async, spread, inbound } = opts
    const topic = inbound ? EventTopics.message.inbound : EventTopics.message.outbound
    const event = async ? topic.async : topic.sync
    return spread
      ? await this.fireBatch(event, batch)
      : await this.fire(event.batch, batch)
  }

  public _fireMessageEvent = async (opts: {
    async?: boolean
    inbound?: boolean
    data: IBotMessageEvent
  }) => {
    const topic = opts.inbound ? EventTopics.message.inbound : EventTopics.message.outbound
    const event = opts.async ? topic.async : topic.sync
    await this.fire(event, opts.data)
  }

  public _fireDeliveryErrorBatchEvent = async (opts: {
    errors: ITradleObject[]
    async?: boolean
    batchSize?: number
  }) => {
    const { async, errors, batchSize=10 } = opts
    const batches = _.chunk(errors, batchSize)
    const baseTopic = EventTopics.delivery.error
    const topic = async ? baseTopic.async : baseTopic
    await Promise.each(batches, batch => this.fireBatch(topic, batch))
  }

  public warmUpCaches = async () => {
    await Promise.all([
      this.identity.getPermalink(),
      this.identity.getPublic()
    ])
  }

  private construct = (Ctor) => {
    return new Ctor(this)
  }

  private define = (property: string, path: string, instantiator: Function) => {
    let instance
    defineGetter(this, property, () => {
      if (!instance) {
        if (path) {
          const subModule = requireDefault(path)
          instance = instantiator(subModule)
        } else {
          instance = instantiator()
        }

        this.logger.silly(`defined ${property}`)
      }

      return instance
    })
  }
}

const toSimpleMiddleware = handler => async (ctx, next) => {
  await handler(ctx.event)
  await next()
}

const maybeAddOld = (bot: Bot, change: ISaveEventPayload, async: boolean):ISaveEventPayload|Promise<ISaveEventPayload> => {
  if (async && !change.old && change.value && change.value._prevlink) {
    return addOld(bot, change)
  }

  return change
}

const addOld = (bot: Bot, target: ISaveEventPayload): Promise<ISaveEventPayload> => {
  return bot.objects.get(target.value._prevlink)
    .then(old => target.old = old, Errors.ignoreNotFound)
    .then(() => target)
}