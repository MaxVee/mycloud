import AWS = require('aws-sdk')
import Identities from './identities'
import Objects from './objects'
import Env from './env'
import { IDebug, ITradleMessage, ITradleObject, IECMiniPubKey } from './types'
import { utils as tradleUtils } from '@tradle/engine'
import * as Errors from './errors'
import {
  pick,
  omit,
  typeforce,
  pickVirtual,
  setVirtual,
  extend,
  bindAll,
  RESOLVED_PROMISE
} from './utils'
import { getLink } from './crypto'
import { prettify } from './string-utils'
import * as types from './typeforce-types'
import {
  TYPE,
  TYPES,
  MAX_CLOCK_DRIFT,
  SEQ,
  PREV_TO_RECIPIENT,
  PERMALINK,
  PREVLINK
} from './constants'

const { unserializeMessage } = tradleUtils
const {
  MESSAGE,
  IDENTITY,
  SELF_INTRODUCTION,
  INTRODUCTION,
  IDENTITY_PUBLISH_REQUEST
} = TYPES

interface IMessageStub {
  time: number
  link: string
}

interface ISeqAndLink {
  seq: number
  link: string
}

export default class Messages {
  private env: Env
  private debug: IDebug
  private identities: Identities
  private objects: Objects
  private tables: any
  private inbox: any
  private outbox: any

  constructor (opts: {
    env: Env,
    identities: Identities,
    objects: Objects,
    tables: any
  }) {
    const { env, identities, objects, tables } = opts
    this.env = env
    this.debug = env.logger('messages')
    this.identities = identities
    this.objects = objects
    this.tables = tables
    this.outbox = tables.Outbox
    this.inbox = tables.Inbox
  }

  public normalizeInbound = (event):ITradleMessage => {
    let message
    if (Buffer.isBuffer(event)) {
      try {
        message = unserializeMessage(event)
      } catch (err) {
        this.debug('unable to unserialize message', event, err)
        throw err
      }
    } else {
      message = event
    }

    const { recipientPubKey } = message
    if (!recipientPubKey) {
      throw new Errors.InvalidMessageFormat('unexpected format')
    }

    const { pub } = recipientPubKey
    if (!Buffer.isBuffer(pub)) {
      recipientPubKey.pub = new Buffer(pub.data)
    }

    validateInbound(message)
    return message
  }

  public getPropsDerivedFromLast = (last) => {
    const seq = last ? last.seq + 1 : 0
    const props = { [SEQ]: seq }
    if (last) {
      props[PREV_TO_RECIPIENT] = last.link
    }

    return props
  }

  public messageToEventPayload = (message: ITradleMessage) => {
    const neutered = this.stripData(message)
    return {
      ...neutered,
      recipientPubKey: this.serializePubKey(message.recipientPubKey)
    }
  }

  public messageFromEventPayload = (event):ITradleMessage => {
    return {
      ...event,
      recipientPubKey: this.unserializePubKey(event.recipientPubKey)
    }
  }

  public serializePubKey = (key:IECMiniPubKey):string => {
    return `${key.curve}:${key.pub.toString('hex')}`
  }

  public unserializePubKey = (key:string):IECMiniPubKey => {
    const [curve, pub] = key.split(':')
    return {
      curve,
      pub: new Buffer(pub, 'hex')
    }
  }

  public getMessageStub = (opts: {
    message: ITradleMessage,
    error?: Error
  }):IMessageStub => {
    const { message, error } = opts
    const stub = {
      link: (error && error.link) || getLink(message),
      time: message.time
    }

    typeforce(types.messageStub, stub)
    return stub
  }

  public stripData = (message: ITradleMessage) => {
    return {
      ...message,
      object: pickVirtual(message.object)
    }
  }

  public putMessage = async (message: ITradleMessage) => {
    setVirtual(message, {
      _payloadType: message.object[TYPE],
      _payloadLink: message.object._link,
      _payloadAuthor: message.object._author,
    })

    const item = this.messageToEventPayload(message)
    if (message._inbound) {
      await this.putInboundMessage({ message, item })
    } else {
      await this.putOutboundMessage({ message, item })
    }
  }

  public putOutboundMessage = async (opts: {
    message: ITradleMessage,
    item
  }):Promise<void> => {
    const { item } = opts
    await this.outbox.put({ Item: item })
  }

  public putInboundMessage = async (opts: {
    message: ITradleMessage,
    item
  }):Promise<void> => {
    const { item, message } = opts
    const params = {
      Item: item,
      ConditionExpression: 'attribute_not_exists(#link)',
      ExpressionAttributeNames: {
        '#link': '_link'
      }
    }

    try {
      await this.inbox.put(params)
    } catch (err) {
      if (err.code === 'ConditionalCheckFailedException') {
        const dErr = new Errors.Duplicate()
        dErr.link = getLink(message)
        throw dErr
      }

      throw err
    }
  }

  public loadMessage = async (message: ITradleMessage):Promise<ITradleMessage> => {
    const body = await this.objects.get(getLink(message.object))
    message.object = extend(message.object || {}, body)
    return message
  }

  public getMessageFrom = async (opts: {
    author: string,
    time: number,
    link?: string,
    body?:boolean
  }):Promise<ITradleMessage> => {
    const { author, time, link, body=true } = opts
    if (body && link) {
      // prime cache
      this.objects.prefetch(link)
    }

    return await this.maybeAddBody({
      message: await this.get(this.inbox, {
        _author: author,
        time
      }),
      body
    })
  }

  public getMessagesFrom = async (opts: {
    author: string,
    gt: number,
    limit: number,
    body: boolean
  }):Promise<ITradleMessage[]> => {
    const { author, gt, limit, body=true } = opts
    this.debug(`looking up inbound messages from ${author}, > ${gt}`)
    const params = this.getMessagesFromQuery({ author, gt, limit })
    const messages = await this.find(this.inbox, params)
    return body ? Promise.all(messages.map(this.loadMessage)) : messages
  }

  public getLastMessageFrom = async (opts: {
    author: string,
    body: boolean
  }):Promise<ITradleMessage> => {
    const { author, body=true } = opts
    const params = this.getLastMessageFromQuery({ author })
    return this.maybeAddBody({
      message: await this.findOne(this.inbox, params),
      body
    })
  }

  public maybeAddBody = async (opts: {
    message:any,
    body: boolean
  }):Promise<ITradleMessage> => {
    const { message, body } = opts
    return body ? this.loadMessage(message) : message
  }

  public getLastSeqAndLink = async (opts: { recipient: string }):Promise<ISeqAndLink|null> => {
    const { recipient } = opts
    this.debug(`looking up last message to ${recipient}`)

    const query = this.getLastMessageToQuery({ recipient })
    query.ExpressionAttributeNames!['#link'] = '_link'
    query.ExpressionAttributeNames![`#${SEQ}`] = SEQ
    query.ProjectionExpression = `#${SEQ}, #link`

    let last
    try {
      last = await this.outbox.findOne(query)
      this.debug('last message:', prettify(last))
      return {
        seq: last[SEQ],
        link: last._link
      }
    } catch (err) {
      if (err instanceof Errors.NotFound) {
        return null
      }

      this.debug('experienced error in getLastSeqAndLink', err.stack)
      throw err
    }
  }

  // const getNextSeq = co(function* ({ recipient }) {
  //   const last = await getLastSeq({ recipient })
  //   return last + 1
  // })

  public getMessagesTo = async (opts: {
    recipient: string,
    gt?: number,
    afterMessage?: any,
    limit?:number,
    body?:boolean
  }):Promise<ITradleMessage[]> => {
    const { recipient, gt=0, afterMessage, limit, body=true } = opts
    if (afterMessage) {
      this.debug(`looking up outbound messages for ${recipient}, after ${afterMessage}`)
    } else {
      this.debug(`looking up outbound messages for ${recipient}, time > ${gt}`)
    }

    const params = this.getMessagesToQuery({ recipient, gt, afterMessage, limit })
    const messages = await this.find(this.outbox, params)
    return body ? Promise.all(messages.map(this.loadMessage)) : messages
  }

  public getLastMessageTo = async (opts: {
    recipient: string,
    body: boolean
  }):Promise<ITradleMessage> => {
    const { recipient, body=true } = opts
    const params = this.getLastMessageToQuery({ recipient })
    return this.maybeAddBody({
      message: await this.findOne(this.outbox, params),
      body
    })
  }

  public getInboundByLink = function getInboundByLink (link) {
    return this.findOne(this.inbox, {
      IndexName: '_link',
      KeyConditionExpression: '#link = :link',
      ExpressionAttributeNames: {
        '#link': '_link'
      },
      ExpressionAttributeValues: {
        ':link': link
      },
      ScanIndexForward: true,
      Limit: 1
    })
  }

  // const assertNotDuplicate = co(function* (link) {
  //   try {
  //     const duplicate = await this.getInboundByLink(link)
  //     this.debug(`duplicate found for message ${link}`)
  //     const dErr = new Errors.Duplicate()
  //     dErr.link = link
  //     throw dErr
  //   } catch (err) {
  //     if (!(err instanceof Errors.NotFound)) {
  //       throw err
  //     }
  //   }
  // })

  public assertTimestampIncreased = async (message) => {
    const link = getLink(message)
    const { time=0 } = message
    try {
      const prev = await this.getLastMessageFrom({
        author: message._author,
        body: false
      })

      if (prev._link === link) {
        const dErr = new Errors.Duplicate()
        dErr.link = link
        throw dErr
      }

      if (prev.time >= time) {
        const msg = `timestamp for message ${link} is <= the previous messages's (${prev._link})`
        this.debug(msg)
        const dErr = new Errors.TimeTravel(msg)
        dErr.link = link
        // dErr.previous = {
        //   time: prev.time,
        //   link: prev.link
        // }

        throw dErr
      }
    } catch (err) {
      if (!(err instanceof Errors.NotFound)) {
        throw err
      }
    }
  }

  public parseInbound = async (message: ITradleMessage):Promise<ITradleMessage> => {
    // TODO: uncomment below, check that message is for us
    // await ensureMessageIsForMe({ message })
    const min = message
    const payload = message.object

    // prereq to running validation
    await this.objects.resolveEmbeds(message)

    this.objects.addMetadata(message)
    this.objects.addMetadata(payload)

    setVirtual(min, pickVirtual(message))
    setVirtual(min.object, pickVirtual(payload))
    message = min

    // TODO:
    // would be nice to parallelize some of these
    // await assertNotDuplicate(messageWrapper.link)

    if (payload[PREVLINK]) {
      // prime cache
      this.objects.prefetch(payload[PREVLINK])
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

    await [
      addMessageAuthor
        .then(() => this.debug('loaded message author')),
      addPayloadAuthor
        .then(() => this.debug('loaded payload author')),
    ]

    if (payload[PREVLINK]) {
      try {
        await this.objects.validateNewVersion({ object: payload })
      } catch (err) {
        if (!(err instanceof Errors.NotFound)) {
          throw err
        }

        this.debug(`previous version of ${payload._link} (${payload[PREVLINK]}) was not found, skipping validation`)
        return
      }
    }

    this.debug('added metadata for message and wrapper')
    if (this.env.NO_TIME_TRAVEL) {
      await this.assertTimestampIncreased(message)
    }

    setVirtual(message, {
      _inbound: true
    })

    return message
  }

  public preProcessInbound = async (event):Promise<ITradleMessage> => {
    const message = this.normalizeInbound(event)
    if (message[TYPE] !== MESSAGE) {
      throw new Errors.InvalidMessageFormat('expected message, got: ' + message[TYPE])
    }

    // assertNoDrift(message)

    // validateResource({ models, resource: message })

    const { object } = message
    const identity = getIntroducedIdentity(object)
    if (identity) {
      await this.identities.validateAndAdd(identity)
    }

    return message
  }

  private get = (table, Key):Promise<ITradleMessage> => {
    return table
      .get({ Key })
      .then(this.messageFromEventPayload)
  }

  private findOne = (table, params):Promise<ITradleMessage> => {
    return table
      .findOne(params)
      .then(this.messageFromEventPayload)
  }

  private find = (table, params):Promise<ITradleMessage[]> => {
    return table
      .find(params)
      .then(events => events.map(this.messageFromEventPayload))
  }

  private getMessagesFromQuery = ({
    author,
    gt,
    limit
  }):AWS.DynamoDB.DocumentClient.QueryInput => {
    const params:AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: this.inbox.name,
      KeyConditionExpression: '#author = :author AND #time > :time',
      ExpressionAttributeNames: {
        '#author': '_author',
        '#time': 'time'
      },
      ExpressionAttributeValues: {
        ':author': author,
        ':time': gt
      },
      ScanIndexForward: true
    }

    if (limit) {
      params.Limit = limit
    }

    return params
  }

  private getLastMessageFromQuery = (opts: {
    author: string
  }):AWS.DynamoDB.DocumentClient.QueryInput => {
    const { author } = opts
    return {
      TableName: this.inbox.name,
      KeyConditionExpression: '#author = :author AND #time > :time',
      ExpressionAttributeNames: {
        '#author': '_author',
        '#time': 'time'
      },
      ExpressionAttributeValues: {
        ':author': author,
        ':time': 0
      },
      ScanIndexForward: false,
      Limit: 1
    }
  }

  private getMessagesToQuery = (opts: {
    recipient: string,
    gt?: number,
    afterMessage?: string,
    limit?: number
  }):AWS.DynamoDB.DocumentClient.QueryInput => {
    const { recipient, gt, afterMessage, limit } = opts
    const params:AWS.DynamoDB.DocumentClient.QueryInput = {
      TableName: this.outbox.name,
      KeyConditionExpression: `#recipient = :recipient AND #time > :time`,
      ExpressionAttributeNames: {
        '#recipient': '_recipient',
        '#time': 'time'
      },
      ExpressionAttributeValues: {
        ':recipient': recipient,
        ':time': gt
      },
      ScanIndexForward: true
    }

    if (afterMessage) {
      params.ExclusiveStartKey = afterMessage
    }

    if (limit) {
      params.Limit = limit
    }

    return params
  }

  private getLastMessageToQuery = (opts: {
    recipient: string
  }):AWS.DynamoDB.DocumentClient.QueryInput => {
    const { recipient } = opts
    return {
      TableName: this.outbox.name,
      KeyConditionExpression: `#recipient = :recipient AND #time > :time`,
      ExpressionAttributeNames: {
        '#recipient': '_recipient',
        '#time': 'time'
      },
      ExpressionAttributeValues: {
        ':recipient': recipient,
        ':time': 0
      },
      ScanIndexForward: false,
      Limit: 1
    }
  }
// private assertNoDrift = (message) => {
//   const drift = message.time - Date.now()
//   const side = drift > 0 ? 'ahead' : 'behind'
//   if (Math.abs(drift) > MAX_CLOCK_DRIFT) {
//     this.debug(`message is more than ${MAX_CLOCK_DRIFT}ms ${side} server clock`)
//     throw new Errors.ClockDrift(`message is more than ${MAX_CLOCK_DRIFT}ms ${side} server clock`)
//   }
// }

}

// private static methods


// for this to work, need a Global Secondary Index on `time`
//
// const getInboundByTimestamp = co(function* ({ gt }) {
//   this.debug(`looking up inbound messages with time > ${gt}`)
//   const time = gt
//   const KeyConditionExpression = `time > :time`

//   const params = {
//     IndexName: 'time',
//     KeyConditionExpression,
//     ExpressionAttributeValues: {
//       ':gt': time,
//     },
//     ScanIndexForward: true
//   }

//   const messages = await Tables.Inbox.find(params)
//   return await Promise.all(messages.map(loadMessage))
// })

const validateInbound = (message) => {
  try {
    typeforce(types.message, message)
  } catch (err) {
    throw new Errors.InvalidMessageFormat(err.message)
  }
}

const getIntroducedIdentity = (payload) => {
  const type = payload[TYPE]
  if (type === IDENTITY) return payload

  if (type === SELF_INTRODUCTION || type === INTRODUCTION || type === IDENTITY_PUBLISH_REQUEST) {
    return payload.identity
  }
}
