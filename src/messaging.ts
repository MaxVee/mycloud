import _ from 'lodash'
import Debug from 'debug'
import { utils, protocol } from '@tradle/engine'
import { DB } from '@tradle/dynamodb'
import Embed from '@tradle/embed'
import buildResource from '@tradle/build-resource'
import { getChainKey, getPermalink, addLinks, getSigningKey } from './crypto'
import {
  cachifyPromiser,
  setVirtual,
  pickVirtual,
  omitVirtual,
  hasVirtualDeep,
  omitVirtualDeep,
  typeforce,
  series,
  ensureTimestamped,
  ensureNoVirtualProps,
  copyVirtual,
  summarizeObject
} from './utils'

import Errors from './errors'
import * as types from './typeforce-types'
import Env from './env'
import {
  IDENTITY_KEYS_KEY,
  SEQ,
  PREVLINK,
  OWNER,
  TYPE,
  TYPES,
  SIG,
  PRIVATE_CONF_BUCKET,
  PERMALINK,
  DB_IGNORE_PAYLOAD_TYPES,
} from './constants'

import {
  Bucket,
  ISession,
  ITradleMessage,
  ITradleObject,
  IIdentity,
  IPubKey,
  IDebug,
  ILiveDeliveryOpts,
  ISendOpts,
  IBatchSendOpts,
  IECMiniPubKey,
  ISaveObjectOpts,
  Friends,
  Logger,
  Auth,
  Identities,
  Messages,
  Objects,
  Push,
  Seals,
  ModelStore,
  Delivery,
  Identity,
  Storage,
  TaskManager,
} from './types'

const {
  MESSAGE,
  IDENTITY,
  SELF_INTRODUCTION,
  INTRODUCTION,
  IDENTITY_PUBLISH_REQUEST
} = TYPES

type PayloadWrapper = {
  new: boolean
  asStored: ITradleObject
  asSigned: ITradleObject
}

type MessagingOpts = {
  env: Env
  logger: Logger
  objects: Objects
  identities: Identities
  identity: Identity
  storage: Storage
  messages: Messages
  auth: Auth
  db: DB
  friends: Friends
  delivery: Delivery
  seals: Seals
  modelStore: ModelStore
  pushNotifications: Push
  tasks: TaskManager
  network: any
}

export default class Messaging {
  private env: Env
  private get objects() { return this.components.objects }
  private get messages() { return this.components.messages }
  private get identities() { return this.components.identities }
  private get identity() { return this.components.identity }
  private get auth() { return this.components.auth }
  private get db() { return this.components.db }
  private get delivery() { return this.components.delivery }
  private get friends() { return this.components.friends }
  private get storage() { return this.components.storage }
  private get modelStore() { return this.components.modelStore }
  private get seals() { return this.components.seals }
  private get pushNotifications() { return this.components.pushNotifications }
  private get tasks() { return this.components.tasks }
  private network: any
  private components: MessagingOpts
  private logger:Logger
  constructor (components: MessagingOpts) {
    this.components = components
    const { env, logger, network } = components

    this.env = env
    this.logger = logger
    this.network = network
  }

  public getOrCreatePayload = async ({ link, object, author }):Promise<PayloadWrapper> => {
    const ret = {
      new: object && !object[SIG],
      asStored: null,
      asSigned: null
    }

    if (object) {
      if (ret.new) {
        object = await this.identity.sign({ author, object })
        ret.asSigned = object
      }

      const type = object[TYPE]
      const saveToDB = !DB_IGNORE_PAYLOAD_TYPES.outbound.includes(type)
      if (!saveToDB) {
        this.logger.debug(`not saving ${type} to type-differentiated table`)
      }

      ret.asStored = await this.storage.save({ object, saveToDB })
    } else {
      ret.asStored = await this.objects.get(link)
    }

    if (!ret.asSigned) {
      ret.asSigned = await this.objects.resolveEmbeds(_.cloneDeep(ret.asStored))
    }

    copyVirtual(ret.asSigned, ret.asStored)
    return ret
  }

  public receiveMessage = async ({
    message,
    clientId
  }: {
    message: any,
    clientId?:string
  }):Promise<ITradleMessage> => {
    ensureNoVirtualProps({
      models: this.modelStore.models,
      resource: message
    })

    if (clientId) {
      const { object } = message
      const identity = getIntroducedIdentity(object)
      if (identity) {
        // small optimization to avoid validating the same identity
        // we just validated during auth
        const link = buildResource.link(identity)
        const alreadyHaveContact = clientId &&
          !identity[PERMALINK] &&
          link === this.auth.getPermalinkFromClientId(clientId)

        if (!alreadyHaveContact) {
          await this.identities.addContact(identity)
        }
      }
    }

    try {
      return await this._doReceiveMessage({ message })
    } catch (err) {
      err.progress = message
      throw err
    }
  }

  // TODO: run this on message stream
  public watchSealedPayload = async ({ seal, object }) => {
    this.logger.debug('message has seal identifier for payload', seal)

    const { flavor, networkName } = this.network
    if (seal.blockchain === flavor && seal.network === networkName) {
      this.logger.info('placing watch on seal', seal)
      try {
        await this.seals.watch({
          object,
          link: seal.link,
          key: {
            type: this.network.flavor,
            curve: this.network.curve,
            pub: seal.basePubKey.toString('hex')
          }
        })
      } catch (err) {
        Errors.ignore(err, Errors.Duplicate)
      }
    } else {
      this.logger.warn('seal is on a different network, ignoring for now')
    }
  }

  // public only for testing purposes
  public _doReceiveMessage = async ({ message }):Promise<ITradleMessage> => {
    message = await this.normalizeAndValidateInboundMessage(message)

    this.logger.debug('receiving message', summarizeObject(message))

    const saveToDB = !DB_IGNORE_PAYLOAD_TYPES.inbound.includes(message.object[TYPE])
    const tasks:Promise<any>[] = [
      this.storage.save({ object: message.object, saveToDB }),
      this.messages.save(message)
    ]

    if (message.seal) {
      tasks.push(this.watchSealedPayload(message))
    }

    // prime cache
    this.tasks.add({
      name: 'getauthor',
      promiser: () => this.identities.byPermalink(message._author).catch(Errors.ignoreNotFound)
    })

    const [payload] = await Promise.all(tasks)
    message.object = payload
    return message
  }

  public normalizeAndValidateInboundMessage = async (message: ITradleMessage):Promise<ITradleMessage> => {
    // TODO: uncomment below, check that message is for us
    // await ensureMessageIsForMe({ message })
    const min = message
    // const payload = message.object

    // prereq to running validation
    await this.objects.resolveEmbeds(message)

    this.objects.addMetadata(message)
    this.objects.addMetadata(message.object)

    setVirtual(min, pickVirtual(message))
    setVirtual(min.object, pickVirtual(message.object))
    message = min
    const payload = message.object

    // TODO:
    // would be nice to parallelize some of these
    // await assertNotDuplicate(messageWrapper.link)

    if (payload[PREVLINK]) {
      // prime cache
      this.logger.debug('TODO: validate against previous version')
      // this.objects.prefetch(payload[PREVLINK])
    }

    const addMessageAuthor = this.identities.addAuthorInfo(message)
    let addPayloadAuthor
    if (payload._sigPubKey === message._sigPubKey) {
      addPayloadAuthor = addMessageAuthor.then(() => {
        setVirtual(payload, { _author: message._author })
      })
    } else {
      addPayloadAuthor = this.identities.addAuthorInfo(payload)
    }

    await Promise.all([
      addMessageAuthor
        .then(() => this.logger.debug('loaded message author')),
      addPayloadAuthor
        .then(() => this.logger.debug('loaded payload author')),
    ])

    if (payload[PREVLINK]) {
      this.logger.warn(`validation of new versions of objects is temporarily disabled,
        until employees switch to command-based operation, rather than re-signing`)

      // try {
      //   await this.objects.validateNewVersion({ object: payload })
      // } catch (err) {
      //   if (!(err instanceof Errors.NotFound)) {
      //     throw err
      //   }

      //   this.debug(`previous version of ${payload._link} (${payload[PREVLINK]}) was not found, skipping validation`)
      // }
    }

    this.logger.debug('added metadata for message and wrapper')
    if (this.env.NO_TIME_TRAVEL) {
      await this.messages.assertTimestampIncreased(message)
    }

    setVirtual(message, {
      _inbound: true
    })

    return message
  }

  // const ensureMessageIsForMe = co(function* ({ message }) {
  //   const toPubKey = message.recipientPubKey.pub.toString('hex')
  //   const recipient = await getPublic()
  //   const myPubKey = recipient.object.pubkeys.find(pubKey => {
  //     return pubKey.pub === toPubKey
  //   })

  //   if (!myPubKey) {
  //     this.debug(`ignoring message meant for someone else (with pubKey: ${toPubKey}) `)
  //     throw new Errors.MessageNotForMe(`message to pub key: ${toPubKey}`)
  //   }
  // })

  public queueMessageBatch = async (batch: IBatchSendOpts):Promise<ITradleMessage[]> => {
    const byRecipient = _.groupBy(batch, 'recipient')
    const results = await Promise.all(Object.keys(byRecipient).map(recipient => {
      return this._queueMessageBatch(byRecipient[recipient])
    }))

    return _.flatten(results)
  }

  public _queueMessageBatch = async (batch: IBatchSendOpts):Promise<ITradleMessage[]> => {
    const { recipient } = batch[0]
    this.logger.debug(`sending batch of ${batch.length} messages to ${recipient}`)
    const messages = await series(batch.map(
      sendOpts => () => this._doQueueMessage(sendOpts))
    )

    return messages
  }

  public queueMessage = async (opts: ISendOpts):Promise<ITradleMessage> => {
    const results = await this.queueMessageBatch([opts])
    return results[0]
  }

  public attemptLiveDelivery = async (opts: ILiveDeliveryOpts) => {
    const { recipient, messages } = opts
    if (!messages.length) return

    const promiseSession = opts.session
      ? Promise.resolve(opts.session)
      : this.auth.getLiveSessionByPermalink(recipient).catch(err => {
          Errors.ignoreNotFound(err)
          this.logger.debug('iot session not found for counterparty', { permalink: recipient })
          return undefined
        })

    const promiseFriend = opts.friend
      ? Promise.resolve(opts.friend)
      : this.friends.getByIdentityPermalink(recipient).catch(err => {
          Errors.ignoreNotFound(err)
          this.logger.debug('friend not found for counterparty', { permalink: recipient })
          return undefined
        })

    try {
      await this._attemptLiveDelivery({
        ...opts,
        session: await promiseSession,
        friend: await promiseFriend
      })
    } catch (err) {
      const error = { error: err.stack }
      if (Errors.isNotFound(err)) {
        this.logger.debug('live delivery canceled', error)
      } else if (Errors.matches(err, Errors.ClientUnreachable)) {
        this.logger.debug('live delivery failed, client unreachable', { recipient })
        if (this.pushNotifications) {
          try {
            await this.sendPushNotification(recipient)
          } catch (pushErr) {
            this.logger.error('failed to send push notification', { message: err.message })
          }
        }
      } else {
        // rethrow, as this is likely a developer error
        this.logger.error('live delivery failed due, likely to developer error', {
          messages,
          ...error
        })

        throw err
      }
    }
  }

  private _attemptLiveDelivery = async (opts: ILiveDeliveryOpts) => {
    const { messages, recipient, friend } = opts
    if (friend) {
      const delivered = await this._deliverPreviouslyUndelivered(opts)
      if (delivered) return
    }

    this.logger.debug(`attempting to deliver batch of ${messages.length} messages to ${recipient}`)
    await this.delivery.deliverBatch({
      ...opts,
      messages: messages.map(this.messages.formatForDelivery)
    })
  }

  private _deliverPreviouslyUndelivered = async (opts: ILiveDeliveryOpts):Promise<boolean> => {
    const { messages, recipient, friend } = opts

    let deliveryError
    try {
      deliveryError = await this.delivery.http.getError(recipient)
    } catch (err) {
      Errors.ignoreNotFound(err)
      return false
    }

    this.logger.debug('delivering previously undelivered messages', deliveryError)
    await this.delivery.deliverMessages({
      recipient,
      friend,
      range: this.delivery.http.getRangeFromError(deliveryError)
    })

    return true
  }

  public sendPushNotification = async (recipient:string):Promise<void> => {
    const { identity, keys } = await this.identity.getPrivate()
    await this.pushNotifications.push({
      key: getSigningKey(keys),
      identity,
      subscriber: recipient
    })
  }

  public registerWithPushNotificationsServer = async ():Promise<void> => {
    const { identity, keys } = await this.identity.getPrivate()
    await this.pushNotifications.ensureRegistered({
      key: getSigningKey(keys),
      identity
    })
  }

  // public for testing purposes
  public _doQueueMessage = async (opts):Promise<ITradleMessage> => {
    typeforce({
      recipient: types.link,
      object: typeforce.maybe(typeforce.Object),
      other: typeforce.maybe(typeforce.Object),
    }, opts)

    if (!opts.time) {
      opts.time = Date.now()
    }

    if (!opts.author) {
      opts.author = await this.identity.getPrivate()
    }

    const { author, recipient, link, object, other={} } = opts

    // run in parallel
    const promisePayload = this.getOrCreatePayload({ link, object, author })
    const promisePrev = this.messages.getLastSeqAndLink({ recipient })
    const promiseRecipient = this.identities.byPermalink(recipient)
    const [payload, recipientObj] = await Promise.all([
      promisePayload,
      promiseRecipient
    ])

    // the signature will be validated against the object with
    // media embeded as data urls
    const payloadVirtual = pickVirtual(payload.asSigned)
    const unsignedMessage = _.extend({}, other, {
      [TYPE]: MESSAGE,
      recipientPubKey: utils.sigPubKey(recipientObj),
      object: omitVirtual(payload.asSigned),
      time: opts.time
    })

    // TODO:
    // efficiency can be improved
    // message signing can be done in parallel with putObject in getOrCreatePayload

    let attemptsToGo = 3
    let prev = await promisePrev
    let seq
    let signedMessage
    while (attemptsToGo--) {
      _.extend(unsignedMessage, this.messages.getPropsDerivedFromLast(prev))

      seq = unsignedMessage[SEQ]
      this.logger.debug(`signing message ${seq} to ${recipient}`)
      signedMessage = await this.identity.sign({ author, object: unsignedMessage })
      setVirtual(signedMessage, {
        _author: getPermalink(author.identity),
        _recipient: getPermalink(recipientObj)
      })

      setVirtual(signedMessage.object, payloadVirtual)
      try {
        await this.messages.save(signedMessage)
        signedMessage.object = payload.asStored
        return signedMessage
      } catch (err) {
        Errors.ignore(err, Errors.Duplicate)
        this.logger.info(`seq was taken by another message, retrying`, {
          seq,
          recipient
        })

        prev = await this.messages.getLastSeqAndLink({ recipient })
      }
    }

    throw new Errors.CloudServiceError({
      service: 'dynamodb',
      message: 'failed to create outbound message after 3 retries',
      retryable: true
    })
  }

  public validateNewVersion = async (opts: { object: ITradleObject }) => {
    const { identities } = this
    const { object } = opts
    const previous = await this.objects.get(object[PREVLINK])
    const getNewAuthorInfo = object._author
      ? Promise.resolve(object)
      : identities.getAuthorInfo(object)

    if (previous[OWNER]) {
      const { _author } = await getNewAuthorInfo
      // OWNER may change to an array of strings in the future
      if (![].concat(previous[OWNER]).includes(_author)) {
        throw new Errors.InvalidAuthor(`expected ${previous[OWNER]} as specified in the previous verison's ${OWNER} property, got ${_author}`)
      }
    }

    const getOldAuthor = previous._author ? Promise.resolve(previous) : identities.getAuthorInfo(previous)
    // ignore error: Property '_author' is optional in type 'ITradleObject' but required in type 'AuthorInfo'
    // @ts-ignore
    const [newInfo, oldInfo] = await Promise.all([getNewAuthorInfo, getOldAuthor])
    if (newInfo._author !== oldInfo._author) {
      throw new Errors.InvalidAuthor(`expected ${oldInfo._author}, got ${newInfo._author}`)
    }

    try {
      protocol.validateVersioning({
        object,
        prev: previous,
        orig: object[PERMALINK]
      })
    } catch (err) {
      throw new Errors.InvalidVersion(err.message)
    }
  }

  // private isAuthoredByMe = async (object:ITradleObject) => {
  //   const promiseMyPermalink = this.identity.getPermalink()
  //   let { _author } = object
  //   if (!_author) {
  //     ({ _author } = await this.identities.getAuthorInfo(object))
  //   }

  //   const myPermalink = await promiseMyPermalink
  //   return _author === myPermalink
  // }
}

export { Messaging }

const getIntroducedIdentity = (payload) => {
  const type = payload[TYPE]
  if (type === IDENTITY) return payload

  if (type === SELF_INTRODUCTION || type === INTRODUCTION || type === IDENTITY_PUBLISH_REQUEST) {
    return payload.identity
  }
}