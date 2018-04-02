// @ts-ignore
import Promise from 'bluebird'
import compose, { Middleware } from 'koa-compose'
import { toBatchEvent, EventTopic } from './events'
import { isPromise } from './utils'
import { TopicOrString, IHooks } from './types'

interface MiddlewareMap<Context> {
  [key: string]: Middleware<Context>[]
}

type DefaultContext = {
  event: any
}

type GetContextForEvent<Context> = (event: string, payload: any) => Context

const defaultGetContextForEvent:GetContextForEvent<any> = (event, payload) => ({
  event: payload
})

export class MiddlewareContainer<Context=DefaultContext> implements IHooks {
  private middleware: MiddlewareMap<Context>
  private getContextForEvent: GetContextForEvent<Context>
  constructor ({ getContextForEvent=defaultGetContextForEvent } : {
    getContextForEvent?: GetContextForEvent<Context>
  }={}) {
    this.getContextForEvent = getContextForEvent
    this.middleware = {
      '*': []
    }
  }

  public hook = (event, middleware) => {
    event = eventToString(event)
    this.getMiddleware(event).push(middleware)
  }

  public hookSimple = (event, handler) => {
    event = eventToString(event)
    this.hook(event, toSimpleMiddleware(handler))
  }

  public fire = async (event:TopicOrString, payload:any) => {
    event = eventToString(event)
    const specific = this.middleware[event] || []
    const wild = this.middleware['*']
    if (!(specific.length || wild.length)) return

    const ctx = this.getContextForEvent(event, payload)
    await compose(specific)(ctx)
    // @ts-ignore
    // hm....
    await compose(wild)({ ctx, event })
    return ctx
  }

  public fireBatch = async (event:TopicOrString, payloads) => {
    event = eventToString(event)
    const batch = await this.fire(toBatchEvent(event), payloads)
    const individual = await Promise.mapSeries(payloads, payload => this.fire(event, payload))
    return {
      batch,
      individual
    }
  }

  public getMiddleware = (event:TopicOrString) => {
    event = eventToString(event)
    if (!this.middleware[event]) {
      this.middleware[event] = []
    }

    return this.middleware[event]
  }
}

const toSimpleMiddleware = handler => async (ctx, next) => {
  await handler(ctx.event)
  await next()
}

const eventToString = (event:TopicOrString) => event.toString()