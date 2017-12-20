import { EventSource } from '../../lambda'

export const createLambda = (opts) => {
  const lambda = opts.bot.createLambda({
    source: EventSource.IOT,
    ...opts
  })

  lambda.tasks.add({
    name: 'getiotendpoint',
    promiser: lambda.bot.iot.getEndpoint
  })

  return lambda.use(createMiddleware(lambda, opts))
}

export const createMiddleware = (lambda, opts) => {
  const { logger, tradle } = lambda
  const { user } = tradle
  return async (ctx, next) => {
    let { event } = ctx
    if (Buffer.isBuffer(event)) {
      ctx.event = event = JSON.parse(event)
    }

    logger.debug('client subscribed', event)
    const { clientId, topics } = event
    await user.onSubscribed({ clientId, topics })
    await next()
  }
}
