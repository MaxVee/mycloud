import { EventEmitter } from 'events'
import DeliveryIot from './delivery-mqtt'
import DeliveryHTTP from './delivery-http'
import Messages from './messages'
import {
  IDelivery,
  IDeliveryRequest,
  IDeliveryResult,
  IDeliverBatchRequest,
  IDeliveryMessageRange,
  IDebug,
  ISession
} from './types'
import { clone, pick } from './utils'
import { ClientUnreachable } from './errors'
import Env from './env'
import Logger from './logger'
import Tradle from './tradle'

const MIN_BATCH_DELIVERY_TIME = 2000
const MAX_BATCH_SIZE = 5

function normalizeOpts (opts) {
  if (!opts.recipient && opts.message) {
    opts.recipient = opts.message._author
  }

  return opts
}

function withTransport (method: string) {
  return async function (opts: any) {
    opts = normalizeOpts({ ...opts, method })
    const transport = await this.getTransport(opts)
    return transport[method](opts)
  }
}

export default class Delivery extends EventEmitter implements IDelivery {
  public ack = withTransport('ack')
  public reject = withTransport('reject')
  public mqtt: any
  public http: DeliveryHTTP
  private friends: any
  private messages: Messages
  private objects: any
  private env: Env
  private logger: Logger
  private tradle: Tradle
  private _deliverBatch = withTransport('deliverBatch')

  constructor (tradle:Tradle) {
    super()

    const { friends, messages, objects, env } = tradle
    this.tradle = tradle
    this.messages = messages
    this.objects = objects
    this.friends = friends
    this.http = new DeliveryHTTP(tradle)
    this.mqtt = new DeliveryIot(tradle)
    this.env = env
    this.logger = this.env.sublogger('delivery')
  }

  public deliverBatch = async (opts:IDeliverBatchRequest) => {
    const { messages } = opts
    messages.forEach(object => this.objects.presignEmbeddedMediaLinks({ object }))
    return this._deliverBatch(opts)
  }

  public deliverMessages = async ({
    recipient,
    session,
    friend,
    range,
    batchSize=MAX_BATCH_SIZE
  }:IDeliveryRequest):Promise<IDeliveryResult> => {
    let { afterMessage } = range
    const { before, after } = range

    this.logger.debug(`looking up messages for ${recipient} > ${after}`)
    const result:IDeliveryResult = {
      finished: false,
      range: { ...range }
    }

    while (true) {
      let messages = await this.messages.getMessagesTo({
        recipient,
        gt: after,
        // lt: before,
        afterMessage,
        limit: batchSize,
        body: true,
      })

      this.logger.debug(`found ${messages.length} messages for ${recipient}`)
      if (!messages.length) {
        result.finished = true
        break
      }

      if (this.env.getRemainingTime() < MIN_BATCH_DELIVERY_TIME) {
        this.logger.info('delivery ran out of time')
        // TODO: recurse
        break
      }

      await this.deliverBatch({ recipient, messages, session, friend })
      let last = messages[messages.length - 1]
      afterMessage = pick(last, ['_recipient', 'time'])
      result.range.afterMessage = afterMessage
      delete result.range.after
    }

    return result
  }

  public getTransport = async (opts: {
    method: string,
    recipient: string,
    clientId?: string,
    session?: ISession,
    friend?: any
  }):Promise<IDelivery> => {
    const { method, recipient, clientId, session, friend } = opts
    if (clientId || session || !(method in this.http)) {
      return this.mqtt
    }

    if (friend || !(method in this.mqtt)) {
      return this.http
    }

    try {
      opts.friend = await this.friends.getByIdentityPermalink(recipient)
      return this.http
    } catch (err) {
      this.logger.debug(`cannot determine transport to use for recipient ${recipient}`)
      throw new ClientUnreachable(`${recipient} is unreachable for live delivery`)
    }
  }
}
